import { readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { emit, files, git, option, root } from './rpc-artifact-io.mts'

const prHead = await git('rev-parse', `${option('pr-head')}^{commit}`)
const prDiffBase = await git('rev-parse', 'e80fae0c4d^{commit}')
const mainBaseline = await git('rev-parse', 'aac38d698f^{commit}')
const diff = await git('diff', '--name-only', prDiffBase, prHead, '--', 'mobile')
const changed = diff.split('\n').filter((file) => /\.[jt]sx?$/.test(file) && !/\.test\./.test(file))
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const rows: unknown[] = []
const inventoried = new Set<string>()
const sources: { file: string; revision: string; sha256: string }[] = []
function inventory(file: string, source: string, revision: string, settingsOnly: boolean): void {
  const sourceId = `${revision}:${file}`
  if (inventoried.has(sourceId)) {
    return
  }
  inventoried.add(sourceId)
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let included = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const literal = node.arguments.find(
        (arg) => ts.isStringLiteral(arg) && /^(settings\.|ui\.|dictation\.|speech\.)/.test(arg.text)
      )
      const callee = node.expression.getText(sf)
      const preference =
        /(?:load|save|set|use)\w*(?:Preference|LinkOpenMode|NotificationsEnabled|DefaultSessionView)/.test(
          callee
        )
      if (literal || (!settingsOnly && preference)) {
        let owner: ts.Node = node
        while (
          owner.parent &&
          !ts.isFunctionDeclaration(owner) &&
          !ts.isArrowFunction(owner) &&
          !ts.isMethodDeclaration(owner)
        ) {
          owner = owner.parent
        }
        let named = owner
        while (named.parent && !('name' in named && named.name)) {
          named = named.parent
        }
        const symbol =
          'name' in named && named.name ? (named.name as ts.Node).getText(sf) : 'module'
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        const method = literal && ts.isStringLiteral(literal) ? literal.text : callee
        const fields = new Set<string>(),
          writes = new Set<string>(),
          failures = new Set<string>()
        const evidence = (part: ts.Node): void => {
          if (ts.isPropertyAccessExpression(part)) {
            fields.add(part.getText(sf))
          }
          if (
            ts.isCallExpression(part) &&
            /^(?:set|save|persist|dispatch|router\.)/.test(part.expression.getText(sf))
          ) {
            writes.add(part.getText(sf))
          }
          if (ts.isThrowStatement(part) || ts.isCatchClause(part)) {
            failures.add(part.getText(sf))
          }
          if (
            ts.isBinaryExpression(part) &&
            [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
              part.operatorToken.kind
            )
          ) {
            failures.add(part.getText(sf))
          }
          ts.forEachChild(part, evidence)
        }
        evidence(owner)
        const id = `${revision === mainBaseline ? 'main' : 'pr19675'}:${file}:${symbol}:${method}:${line}`
        rows.push({
          id,
          file,
          symbol,
          line,
          revision,
          method,
          kind: literal ? 'host-rpc' : 'device-preference',
          recordable: Boolean(literal),
          ...(!literal ? { reason: 'local device storage, no host RPC' } : {}),
          options: literal
            ? node.arguments
                .slice(node.arguments.indexOf(literal) + 2)
                .map((arg) => arg.getText(sf))
            : [],
          arguments: node.arguments.map((arg) => arg.getText(sf)),
          consumedFields: [...fields].sort(),
          writes: [...writes].sort(),
          failures: [...failures].sort(),
          evidenceScope:
            'enclosing function; conservative source expressions, not a validated reader contract',
          scenarioIds: [`${id}:fulfilled`, `${id}:refused`, `${id}:transport-error`],
          scenarioStatus: 'planned-step1'
        })
        included = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (included) {
    sources.push({ file, revision, sha256: hash(source) })
  }
}
for (const file of [...files(join(root, 'mobile/src')), ...files(join(root, 'mobile/app'))].filter(
  (file) => /\.[jt]sx?$/.test(file) && !/\.test\.|\.generated\./.test(file)
)) {
  const source = readFileSync(join(root, file), 'utf8')
  if (/['"]settings\./.test(source)) {
    if ((await git('show', `${mainBaseline}:${file}`)) !== source.trimEnd()) {
      throw new Error(`Main settings source drift: ${file}`)
    }
    inventory(file, source, mainBaseline, true)
  }
}
for (const file of changed) {
  const source = await git('show', `${prHead}:${file}`)
  if (/['"]settings\./.test(source)) {
    inventory(file, source, prHead, true)
  }
}
const pending = changed.filter(
  (file) =>
    file.startsWith('mobile/src/settings/') ||
    /^mobile\/app\/(?:.*settings|notifications)\.tsx$/.test(file)
)
const visited = new Set<string>()
while (pending.length) {
  const file = pending.shift()!
  if (visited.has(file)) {
    continue
  }
  visited.add(file)
  const source = await git('show', `${prHead}:${file}`)
  inventory(file, source, prHead, false)
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
      continue
    }
    const specifier = node.moduleSpecifier.text
    if (
      !specifier.startsWith('.') ||
      !/(settings|dictation|preferences|default-session-view)/.test(specifier)
    ) {
      continue
    }
    const base = posix.normalize(posix.join(dirname(file), specifier))
    for (const extension of ['.ts', '.tsx']) {
      try {
        await git('cat-file', '-e', `${prHead}:${base}${extension}`)
        pending.push(`${base}${extension}`)
        break
      } catch {
        /* Import resolution tries both source extensions. */
      }
    }
  }
}
if (!rows.length) {
  throw new Error('Empty settings census')
}
emit('settings-19675', {
  schemaVersion: 1,
  manifestVersion: 3,
  changesFromV2:
    'Expanded from settings.get reads to all main settings.* literals, PR-touched settings.* sources, related ui.* reads and writes, and voice speech.* requests; existing operation IDs retained, new scenarios remain planned-step1.',
  prHead,
  prDiffBase,
  mainBaseline,
  diffSha256: hash(diff),
  changedFiles: changed,
  files: sources,
  operations: rows
})
