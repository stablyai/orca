import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { emit, files, root } from './rpc-artifact-io.mts'

const sources = ['mobile/packages', 'mobile/plugins']
  .flatMap((directory) => files(join(root, directory)))
  .filter((file) => /\.(swift|kt|m|mm|h|java)$/.test(file))
const entries = sources.map((file) => {
  const source = readFileSync(join(root, file), 'utf8')
  const lines = source.split('\n')
  const rpcCandidates = lines.flatMap((text, index) =>
    /sendRequest|jsonrpc|RpcRequest|rpcMethod|['"](?:settings|worktree|terminal|agentSession|dictation)\.[a-z]/i.test(
      text
    )
      ? [{ line: index + 1, text: text.trim() }]
      : []
  )
  const nativeMethods = [...source.matchAll(/(?:AsyncFunction|Function)\s*\(\s*"([^"]+)"/g)].map(
    (match) => match[1]
  )
  return {
    file,
    sha256: createHash('sha256').update(source).digest('hex'),
    nativeMethods,
    rpcCandidates
  }
})
await emit('native-rpc-inventory', {
  schemaVersion: 1,
  scope: ['mobile/packages', 'mobile/plugins'],
  extensions: ['swift', 'kt', 'm', 'mm', 'h', 'java'],
  entries,
  hostRpcCandidates: entries.flatMap((entry) =>
    entry.rpcCandidates.map((candidate) => ({ file: entry.file, ...candidate }))
  ),
  note: 'Native ABI methods are audio operations; host dictation RPC construction lives in JavaScript and is covered by the access inventory.'
})
