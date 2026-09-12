import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { emit, git, option } from './rpc-artifact-io.mts'
import { rankSuggestions } from '../src/session/mobile-native-chat-autocomplete.ts'
import { buildGithubPrParams, githubPrRepoSlugParam } from '../src/session/github-pr-rpc.ts'

const revision = await git('rev-parse', `${option('regression', 'bcba08b3e4')}^{commit}`)
const sources: { file: string; sha256: string }[] = []
async function reference(
  file: string,
  dependencies: Record<string, unknown> = {}
): Promise<
  Record<string, (...args: unknown[]) => Record<string, (...args: unknown[]) => Promise<unknown>>>
> {
  const source = await git('show', `${revision}:${file}`)
  sources.push({ file, sha256: createHash('sha256').update(source).digest('hex') })
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  const require = (name: string): unknown =>
    dependencies[name] ??
    new Proxy(
      {},
      {
        get: (_target, key) => {
          throw new Error(`Unprovided reference dependency ${name}:${String(key)}`)
        }
      }
    )
  new Function('exports', 'require', code)(exports, require)
  return exports
}
const native = await reference('mobile/src/session/native-host-session-native-chat-operations.ts', {
  './mobile-native-chat-autocomplete': { rankSuggestions }
})
const mutations = await reference('mobile/src/session/github-pr-mutations.ts', {
  './github-pr-rpc': { buildGithubPrParams, githubPrRepoSlugParam }
})
const project = await reference(
  'mobile/src/tasks/native-host-task-project-mutation-operations.ts',
  { '../session/github-pr-mutations': mutations }
)
const detail = await reference('mobile/src/tasks/native-host-task-detail-operations.ts')
const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}
const results: { id: string; killed: boolean; observed: string }[] = []
const pending: Array<(response: unknown) => void> = []
const operations = native.nativeHostSessionNativeChatOperations({
  sendRequest: (method: string) =>
    method === 'files.searchPaths'
      ? Promise.resolve({ ok: false, error: { code: 'method_not_found' } })
      : new Promise((resolve) => pending.push(resolve))
})
const target = { workspaceId: 'A' }
const stale = operations.searchFiles(target, 'app')
await flush()
operations.resetFileSearchCache('A')
operations.resetFileSearchCache('B')
operations.resetFileSearchCache('A')
const fresh = operations.searchFiles(target, 'app')
await flush()
assert.equal(pending.length, 2)
pending[0]({ ok: true, result: { files: [{ relativePath: 'stale/app.ts' }] } })
await stale
const third = await operations.searchFiles(target, 'app')
results.push({
  id: 'b1',
  killed: Array.isArray(third) && third.includes('stale/app.ts'),
  observed: JSON.stringify(third)
})
pending[1]({ ok: true, result: { files: [{ relativePath: 'fresh/app.ts' }] } })
await fresh
let accepted = false
try {
  await project
    .nativeHostTaskProjectMutationOperations({
      sendRequest: async () => ({ ok: true, result: null })
    })
    .merge({ number: 42 }, 'repo-1', 'squash')
  accepted = true
} catch {
  /* The main oracle requires rejection. */
}
results.push({
  id: 'b2',
  killed: accepted,
  observed: accepted ? 'null result accepted' : 'null result rejected'
})
let refuseIssue!: (value: unknown) => void, rejectComments!: (error: Error) => void
const issue = new Promise((resolve) => {
  refuseIssue = resolve
})
const comments = new Promise((_resolve, reject) => {
  rejectComments = reject
})
let error: unknown
const loading = detail
  .nativeHostTaskDetailOperations({
    sendRequest: (method: string) => (method === 'linear.getIssue' ? issue : comments)
  })
  .loadLinear({ issueId: 'issue-1', workspaceId: 'workspace-1' })
  .catch((failure: unknown) => {
    error = failure
  })
refuseIssue({ ok: false, error: { message: 'issue refused' } })
await flush()
rejectComments(new Error('comments transport failed'))
await loading
results.push({
  id: 'b3',
  killed: error instanceof Error && error.message === 'issue refused',
  observed: error instanceof Error ? error.message : String(error)
})
for (const result of results) {
  assert.equal(result.killed, true, `${result.id}: reference no longer exhibits the known defect`)
}
await emit('reference-regressions', {
  revision,
  sources,
  supportingFunctions: ['rankSuggestions', 'buildGithubPrParams', 'githubPrRepoSlugParam'],
  supportingSource:
    'current main; ranking and sender parameter construction only, never reply acceptance or lifecycle',
  results
})
console.log('reference regressions: b1,b2,b3 killed against pinned source')
