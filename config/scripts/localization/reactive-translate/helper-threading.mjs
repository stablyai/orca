import ts from 'typescript-api'
import { pickFreeName } from './file-rewrite.mjs'
import { runsSynchronouslyWithin } from './render-path-translate.mjs'
import { buildTranslateHelperGraph, collectHelperUses } from './translate-helper-graph.mjs'

// Helpers called while rendering are memoized on their arguments under React Compiler, so a
// helper that translates internally keeps the old language. Threading the hook's `t` (and
// `intlLocale`) in as a trailing parameter makes the call depend on the language. Defaults keep
// every other caller unchanged: `t: Translate = translate` delegates to the same function, so
// output is identical whichever value arrives.

const PARAM_NAMES = {
  // Catalog extraction (i18next.config.ts) only recognizes t() and translate(), so no fallback name.
  translate: ['t'],
  getIntlLocale: ['intlLocale', 'uiIntlLocale']
}
const FUNCTIONS = ['translate', 'getIntlLocale']

function isAsyncOrGenerator(fn) {
  return Boolean(
    fn.asteriskToken || fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  )
}

function hasOverloads(mod, name) {
  return mod.sf.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && !statement.body
  )
}

/** Direct i18n calls inside a helper body, with whether they sit in a nested function. */
function directCalls(helper, locals) {
  const calls = []
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      locals.has(node.expression.text)
    ) {
      // A parameter default cannot read a parameter declared after it.
      const inParameters = helper.node.parameters.some(
        (param) => node.getStart() >= param.getStart() && node.getEnd() <= param.getEnd()
      )
      if (!inParameters) {
        const nested = !runsSynchronouslyWithin(node, helper.node)
        calls.push({ node, fn: locals.get(node.expression.text), nested })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(helper.node.body ?? helper.node)
  return calls
}

/** Parameters an earlier run already threaded, so re-running the codemod is idempotent. */
function existingThreadParams(fn) {
  const found = {}
  fn.parameters.forEach((param, index) => {
    if (!ts.isIdentifier(param.name)) {
      return
    }
    const type = param.type?.getText()
    if (type === 'Translate') {
      found.translate = { name: param.name.text, index, existing: true }
    } else if (type === 'string' && PARAM_NAMES.getIntlLocale.includes(param.name.text)) {
      found.getIntlLocale = { name: param.name.text, index, existing: true }
    }
  })
  return found
}

function enclosingHelper(identifier, nodeToHelper) {
  for (let current = identifier.parent; current; current = current.parent) {
    const id = nodeToHelper.get(current)
    if (id) {
      return id
    }
  }
  return null
}

/**
 * Plans helper threading. `inTargets(rel)` limits which render call sites pass the hook values;
 * helper declarations they need are threaded wherever they live.
 */
export function planHelperThreading(
  modules,
  { inTargets, isExcluded = () => false, findI18nLocals, ownerContext }
) {
  const graph = buildTranslateHelperGraph(modules)
  const { renderUses, otherUses } = collectHelperUses(modules, graph)
  const allUses = [...renderUses, ...otherUses]
  const nodeToHelper = new Map([...graph.nodes.values()].map((node) => [node.node, node.id]))
  const info = new Map()
  for (const id of graph.translating.keys()) {
    const node = graph.nodes.get(id)
    const mod = modules.get(node.rel)
    const locals = findI18nLocals(mod.sf)
    info.set(id, {
      node,
      mod,
      calls: directCalls(node, locals),
      uses: [],
      calleeRefs: [],
      blocked: [],
      existing: existingThreadParams(node.node),
      eligible: { translate: false, getIntlLocale: false }
    })
  }
  for (const use of allUses) {
    info.get(use.id)?.uses.push(use)
    const callerId = use.isCall ? enclosingHelper(use.identifier, nodeToHelper) : null
    const caller = callerId && info.get(callerId)
    if (caller) {
      caller.calleeRefs.push({
        id: use.id,
        nested: !runsSynchronouslyWithin(use.identifier, caller.node.node)
      })
    }
  }
  // Structural eligibility: only simple, non-overloaded functions whose every reference is a call.
  for (const [id, entry] of info) {
    const { node, mod, uses } = entry
    const fn = node.node
    const block = (reason) => entry.blocked.push(reason)
    if (isExcluded(node.rel)) {
      block('file excluded from this run')
    }
    if (node.wrapped) {
      block('built by a factory call')
    }
    if (node.typed) {
      block('declared with a type annotation')
    }
    if (isAsyncOrGenerator(fn)) {
      block('async or generator')
    }
    if (fn.parameters.some((param) => param.dotDotDotToken)) {
      block('rest parameter')
    }
    if (ts.isFunctionDeclaration(fn) && hasOverloads(mod, node.name)) {
      block('overloaded')
    }
    for (const use of uses) {
      const call = use.identifier.parent
      if (!use.isCall) {
        block('referenced as a value')
        break
      }
      if (
        call.arguments.some((arg) => ts.isSpreadElement(arg)) ||
        call.arguments.length > fn.parameters.length
      ) {
        block('called with spread or extra arguments')
        break
      }
    }
    entry.id = id
  }
  for (const entry of info.values()) {
    for (const fn of FUNCTIONS) {
      entry.eligible[fn] = Boolean(entry.existing[fn])
    }
  }
  // Closures a helper returns or schedules read the live language when they run, so only work
  // the helper does while it runs needs the parameter.
  const passes = (ref, fn) => Boolean(info.get(ref.id)?.eligible[fn]) && !ref.nested
  // Least fixed point: a helper can take `t` when it translates directly or passes it on.
  let changed = true
  while (changed) {
    changed = false
    for (const entry of info.values()) {
      if (entry.blocked.length > 0) {
        continue
      }
      for (const fn of FUNCTIONS) {
        // The parameter name must be free, or callers would pass a value nothing reads.
        if (entry.eligible[fn] || !pickFreeName(entry.node.node, PARAM_NAMES[fn])) {
          continue
        }
        const direct = entry.calls.filter((call) => call.fn === fn)
        const directOk = direct.some((call) => !call.nested)
        const passesOn = entry.calleeRefs.some((ref) => passes(ref, fn))
        // A captured locale would replace a read at call time inside a closure.
        const nestedLocale = fn === 'getIntlLocale' && direct.some((call) => call.nested)
        if ((directOk || passesOn) && !nestedLocale) {
          entry.eligible[fn] = true
          changed = true
        }
      }
    }
  }
  // Select helpers whose render call sites are in the targets, then the callees they feed.
  const threaded = new Map()
  const queue = []
  const requireThreading = (id, fn) => {
    const entry = info.get(id)
    if (!entry?.eligible[fn]) {
      return false
    }
    const plan = threaded.get(id) ?? { entry, fns: new Set() }
    if (!plan.fns.has(fn)) {
      plan.fns.add(fn)
      threaded.set(id, plan)
      queue.push([id, fn])
    }
    return true
  }
  const renderSites = []
  for (const use of renderUses) {
    if (use.test || !use.duringRender || !inTargets(use.rel) || !use.isCall) {
      continue
    }
    const fns = FUNCTIONS.filter((fn) => info.get(use.id)?.eligible[fn])
    if (fns.length === 0) {
      continue
    }
    renderSites.push({ use, fns })
    for (const fn of fns) {
      requireThreading(use.id, fn)
    }
  }
  while (queue.length > 0) {
    const [id, fn] = queue.pop()
    for (const ref of info.get(id).calleeRefs) {
      if (passes(ref, fn)) {
        requireThreading(ref.id, fn)
      }
    }
  }
  // Fix parameter order and names: t first, then intlLocale, after the existing parameters.
  for (const plan of threaded.values()) {
    const fn = plan.entry.node.node
    plan.params = {}
    let index = fn.parameters.length
    const taken = new Set()
    for (const name of FUNCTIONS) {
      if (!plan.fns.has(name)) {
        continue
      }
      if (plan.entry.existing[name]) {
        plan.params[name] = plan.entry.existing[name]
        continue
      }
      const param = pickFreeName(fn, PARAM_NAMES[name], taken)
      if (!param) {
        plan.fns.delete(name)
        continue
      }
      taken.add(param)
      plan.params[name] = { name: param, index }
      index += 1
    }
  }
  return {
    graph,
    info,
    threaded,
    renderSites,
    files: new Set([
      ...[...threaded.values()].map((plan) => plan.entry.node.rel),
      ...renderSites.map((site) => site.use.rel)
    ]),
    /** Applies this plan's edits for one file. */
    apply(rewrite, stats) {
      for (const plan of threaded.values()) {
        if (plan.entry.node.rel !== rewrite.rel) {
          continue
        }
        const { node, calls } = plan.entry
        const params = []
        for (const fn of FUNCTIONS) {
          const param = plan.params[fn]
          if (!param || param.existing) {
            continue
          }
          const direct = calls.filter((call) => call.fn === fn)
          if (fn === 'translate') {
            rewrite.typeImports.add('Translate')
            params.push(
              direct.length > 0
                ? `${param.name}: Translate = ${rewrite.i18nLocal('translate')}`
                : `${param.name}?: Translate`
            )
            for (const call of direct) {
              rewrite.replaceNode(call.node.expression, param.name)
            }
          } else {
            params.push(
              direct.length > 0
                ? `${param.name}: string = ${rewrite.i18nLocal('getIntlLocale')}()`
                : `${param.name}?: string`
            )
            for (const call of direct) {
              rewrite.replaceNode(call.node, param.name)
            }
          }
        }
        if (params.length > 0) {
          rewrite.addParams(node.node, params)
          stats.helpersThreaded += 1
        }
      }
      // Calls between threaded helpers pass the caller's parameters on.
      for (const plan of threaded.values()) {
        for (const use of plan.entry.uses) {
          if (use.rel !== rewrite.rel) {
            continue
          }
          const callerId = enclosingHelper(use.identifier, nodeToHelper)
          const caller = callerId && threaded.get(callerId)
          if (!caller) {
            continue
          }
          const nested = !runsSynchronouslyWithin(use.identifier, caller.entry.node.node)
          const values = new Map()
          for (const fn of FUNCTIONS) {
            if (plan.params[fn] && caller.params[fn] && !nested) {
              values.set(plan.params[fn].index, caller.params[fn].name)
            }
          }
          if (values.size > 0) {
            rewrite.appendArgs(use.identifier.parent, values)
          }
        }
      }
      for (const { use } of renderSites) {
        if (use.rel !== rewrite.rel) {
          continue
        }
        const plan = threaded.get(use.id)
        const context = ownerContext(rewrite, use)
        if (!context.ok) {
          stats.skipped.push({ rel: use.rel, line: line(use), fn: use.id, reason: context.reason })
          continue
        }
        const values = new Map()
        for (const fn of FUNCTIONS) {
          if (!plan?.params[fn]) {
            continue
          }
          const name = rewrite.ownerBinding(use.owner, fn)
          if (!name) {
            continue
          }
          values.set(plan.params[fn].index, name)
          context.onBinding?.(name)
        }
        if (values.size > 0 && rewrite.appendArgs(use.identifier.parent, values)) {
          stats.helperCallSites += 1
        }
      }
    }
  }
}

function line(use) {
  return (
    use.identifier.getSourceFile().getLineAndCharacterOfPosition(use.identifier.getStart()).line + 1
  )
}
