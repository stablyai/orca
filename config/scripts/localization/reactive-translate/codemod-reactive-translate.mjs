import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { FileRewrite } from './file-rewrite.mjs'
import { planHelperThreading } from './helper-threading.mjs'
import { listTrackedFiles } from '../../static-analysis/ratchet-baseline/ratchet-baseline.mjs'
import {
  SCAN_ROOT,
  calleeName,
  classifyRenderContext,
  collectI18nCalls,
  findI18nImports,
  parseSource
} from './render-path-translate.mjs'
import { loadRendererModules } from './translate-helper-graph.mjs'

// Rewrites render-path translate()/getIntlLocale() in components and hooks to the values of
// useTranslate()/useIntlLocale(), and with --helpers threads those values into the helpers a
// render calls. Semantics-preserving: the hook's `t` delegates to translate() and its locale is
// getIntlLocale() for the same scope, so only identities (what React Compiler memoizes on) change.
//
// Usage: pnpm i18n:reactive-translate [--check] [--helpers] [--verbose] [--exclude=<file>] <paths...>

const LANGUAGE_REVISION_HOOKS = new Set(['useUiLanguageRevision'])

/**
 * Direct `X(...)` calls of PascalCase names anywhere, tests included: a hook in a component that
 * is also called as a plain function would throw outside a render.
 */
function collectDirectlyCalledComponentNames(root, modules) {
  const names = new Set()
  const sources = listTrackedFiles(root, [SCAN_ROOT]).filter((rel) => /\.tsx?$/.test(rel))
  for (const rel of sources) {
    let text = modules.get(rel)?.sf.text
    if (text === undefined) {
      try {
        text = fs.readFileSync(path.join(root, rel), 'utf8')
      } catch {
        continue
      }
    }
    if (!/\b[A-Z]\w*\(/.test(text)) {
      continue
    }
    const sf = modules.get(rel)?.sf ?? parseSource(rel, text)
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /^[A-Z]/.test(node.expression.text)
      ) {
        names.add(node.expression.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return names
}

function ownerName(owner) {
  if ((ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner)) && owner.name) {
    return owner.name.text
  }
  let outer = owner.parent
  while (outer && !ts.isVariableDeclaration(outer) && !ts.isSourceFile(outer)) {
    outer = outer.parent
  }
  return outer && ts.isVariableDeclaration(outer) && ts.isIdentifier(outer.name)
    ? outer.name.text
    : null
}

function languageRevisionNames(fn) {
  const names = new Set()
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      LANGUAGE_REVISION_HOOKS.has(calleeName(node.initializer) ?? '')
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(fn)
  return names
}

function memoDepsArray(memoCall) {
  const deps = memoCall?.arguments[1]
  return deps && ts.isArrayLiteralExpression(deps) ? deps : null
}

/**
 * Whether a render-path node in `owner` can take a hook value, and how: a parameter default
 * cannot (it runs before the body); a useMemo factory can only when its deps already track the
 * language, so adding `t` does not change when it recomputes.
 */
function renderSiteContext(rewrite, node, owner, directlyCalled) {
  const name = ownerName(owner)
  if (name && directlyCalled.has(name)) {
    return { ok: false, reason: `${name} is also called as a plain function` }
  }
  const { context, memoCall } = classifyRenderContext(node, owner)
  if (context === 'deferred') {
    return { ok: false, reason: 'runs after render' }
  }
  if (context === 'param') {
    return { ok: false, reason: 'parameter default (runs before a hook binding exists)' }
  }
  if (context === 'memo') {
    const deps = memoDepsArray(memoCall)
    const revisions = languageRevisionNames(owner)
    const tracksLanguage = deps?.elements.some(
      (element) => ts.isIdentifier(element) && revisions.has(element.text)
    )
    if (!tracksLanguage) {
      return {
        ok: false,
        reason: 'useMemo without a language dependency (adding one changes when it recomputes)'
      }
    }
    return { ok: true, onBinding: (binding) => rewrite.addDepsEntry(deps, binding) }
  }
  return { ok: true }
}

function rewriteDirectCalls(rewrite, directlyCalled, stats) {
  const { calls } = collectI18nCalls(rewrite.sf)
  for (const call of calls) {
    if (!call.owner || call.context === 'deferred') {
      continue
    }
    const context = renderSiteContext(rewrite, call.node, call.owner, directlyCalled)
    const line = rewrite.sf.getLineAndCharacterOfPosition(call.node.getStart(rewrite.sf)).line + 1
    if (!context.ok) {
      stats.skipped.push({ rel: rewrite.rel, line, fn: call.fn, reason: context.reason })
      continue
    }
    const binding = rewrite.ownerBinding(call.owner, call.fn)
    if (!binding) {
      stats.skipped.push({
        rel: rewrite.rel,
        line,
        fn: call.fn,
        reason: '`t` is already bound here (catalog extraction needs that name)'
      })
      continue
    }
    context.onBinding?.(binding)
    rewrite.replaceNode(call.fn === 'translate' ? call.node.expression : call.node, binding)
    stats.calls += 1
  }
}

function normalizeTarget(target) {
  return target.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function runCodemod({
  root = process.cwd(),
  targets = [],
  exclude = [],
  helpers = false,
  write = true
}) {
  const excluded = new Set(exclude.map(normalizeTarget))
  const modules = loadRendererModules(root, { includeTests: helpers })
  const prefixes = targets.map(normalizeTarget)
  const inTargets = (rel) =>
    prefixes.length === 0 ||
    prefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))
  const directlyCalled = collectDirectlyCalledComponentNames(root, modules)
  const stats = { calls: 0, helpersThreaded: 0, helperCallSites: 0, skipped: [], files: [] }
  const plan = helpers
    ? planHelperThreading(modules, {
        inTargets,
        isExcluded: (rel) => excluded.has(rel),
        findI18nLocals: (sf) => findI18nImports(sf).locals,
        ownerContext: (rewrite, use) =>
          renderSiteContext(rewrite, use.identifier, use.owner, directlyCalled)
      })
    : null
  const files = new Set(
    [...modules].filter(([rel, mod]) => !mod.test && inTargets(rel)).map(([rel]) => rel)
  )
  for (const rel of plan?.files ?? []) {
    files.add(rel)
  }
  for (const rel of [...files].sort()) {
    if (excluded.has(rel)) {
      continue
    }
    const mod = modules.get(rel)
    const rewrite = new FileRewrite(rel, mod.sf)
    if (inTargets(rel) && /\b(?:translate|getIntlLocale)\b/.test(mod.sf.text)) {
      rewriteDirectCalls(rewrite, directlyCalled, stats)
    }
    plan?.apply(rewrite, stats)
    const output = rewrite.finish()
    if (output === mod.sf.text) {
      continue
    }
    stats.files.push(rel)
    if (write) {
      fs.writeFileSync(path.join(root, rel), output)
    }
  }
  return { stats, plan }
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const write = !argv.includes('--check')
  const { stats } = runCodemod({
    root,
    targets: argv.filter((arg) => !arg.startsWith('--')),
    // Files to leave untouched, e.g. ones the rewrite would push over the max-lines budget.
    exclude: argv.filter((arg) => arg.startsWith('--exclude=')).map((arg) => arg.slice(10)),
    helpers: argv.includes('--helpers'),
    write
  })
  if (argv.includes('--verbose')) {
    for (const entry of stats.skipped) {
      console.log(`skip ${entry.rel}:${entry.line} ${entry.fn}: ${entry.reason}`)
    }
  }
  console.log(
    `${write ? 'Rewrote' : 'Would rewrite'} ${stats.calls} call(s), threaded ${stats.helpersThreaded} helper(s) into ${stats.helperCallSites} render call site(s), in ${stats.files.length} file(s); left ${stats.skipped.length} for manual review.`
  )
  if (write && stats.files.length > 0) {
    console.log('Then format: pnpm exec oxfmt --write <changed files>')
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
