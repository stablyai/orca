import { afterEach, expect, it } from 'vitest'
import { OmpRpcLocalSessionWriteFence } from './omp-rpc-local-session-write-fence'

let fence: OmpRpcLocalSessionWriteFence
afterEach(() => {
  fence = new OmpRpcLocalSessionWriteFence()
})

it('refuses a normal OMP resume spawn while RPC owns its session', () => {
  fence = new OmpRpcLocalSessionWriteFence()
  expect(fence.reserve('/sessions/current.jsonl', 'rpc-pane:1')).toBe(true)

  expect(() =>
    fence.assertPtySpawnAllowed('omp --resume /sessions/current.jsonl', '/work')
  ).toThrow('agent_session_conflict')
})

it('refuses an OMP resume spawn with configured arguments while RPC owns its session', () => {
  fence = new OmpRpcLocalSessionWriteFence()
  fence.reserve('/sessions/current.jsonl', 'rpc-pane:1')

  expect(() =>
    fence.assertPtySpawnAllowed("omp '--model' 'custom' --resume '/sessions/current.jsonl'", '/work')
  ).toThrow('agent_session_conflict')
})

it.each([
  '/opt/company-omp --resume /sessions/current.jsonl',
  'node /opt/company-omp-wrapper.js --resume /sessions/current.jsonl'
])('refuses a custom OMP command override while RPC owns its session: %s', (command) => {
  fence = new OmpRpcLocalSessionWriteFence()
  fence.reserve('/sessions/current.jsonl', 'rpc-pane:1')

  expect(() => fence.assertPtySpawnAllowed(command, '/work')).toThrow('agent_session_conflict')
})

it('releases the normal OMP resume spawn after RPC ownership ends', () => {
  fence = new OmpRpcLocalSessionWriteFence()
  fence.reserve('/sessions/current.jsonl', 'rpc-pane:1')
  fence.release('/sessions/current.jsonl', 'rpc-pane:1')

  expect(() =>
    fence.assertPtySpawnAllowed('omp --resume /sessions/current.jsonl', '/work')
  ).not.toThrow()
})

it('treats Windows session paths that differ only by casing as one writer target', () => {
  fence = new OmpRpcLocalSessionWriteFence()
  expect(fence.reserve('C:\\Users\\Rahul\\.omp\\sessions\\same.jsonl', 'rpc-pane:1')).toBe(true)

  expect(fence.reserve('c:\\users\\rahul\\.omp\\sessions\\same.jsonl', 'pty-pane:1')).toBe(false)
})

it('refuses the generated quoted bare session id while RPC owns its session', () => {
  fence = new OmpRpcLocalSessionWriteFence()
  fence.reserve('/sessions/2026-09-04T00-00-00-000Z_session-1.jsonl', 'rpc-pane:1')

  expect(() => fence.assertPtySpawnAllowed("omp '--resume' 'session-1'", '/work')).toThrow(
    'agent_session_conflict'
  )
})

it('maps a released bare session id back to its known OMP transcript path', () => {
  fence = new OmpRpcLocalSessionWriteFence()
  const actualPath = '/sessions/2026-09-04T00-00-00-000Z_session-1.jsonl'
  fence.reserve(actualPath, 'rpc:1')
  fence.release(actualPath, 'rpc:1')

  expect(fence.reservePtySpawn("omp --resume 'session-1'", '/worktree', 'pty:1')).toBe(actualPath)
  expect(fence.reserve(actualPath, 'rpc:1')).toBe(false)
})

it.each([
  'omp.cmd --resume /sessions/current.jsonl',
  'omp.bat --resume /sessions/current.jsonl',
  '"C:\\Program Files\\OMP\\omp.cmd" --resume /sessions/current.jsonl'
])('refuses a Windows OMP launcher while RPC owns its session: %s', (command) => {
  fence = new OmpRpcLocalSessionWriteFence()
  fence.reserve('/sessions/current.jsonl', 'rpc-pane:1')

  expect(() => fence.assertPtySpawnAllowed(command, '/work')).toThrow('agent_session_conflict')
})

it.each([
  "omp --resume '/Users/Ada Lovelace/.omp/session.jsonl'",
  'omp --resume "/Users/Ada Lovelace/.omp/session.jsonl"'
])('refuses a quoted absolute resume path containing spaces: %s', (command) => {
  fence = new OmpRpcLocalSessionWriteFence()
  fence.reserve('/Users/Ada Lovelace/.omp/session.jsonl', 'rpc-pane:1')

  expect(() => fence.assertPtySpawnAllowed(command, '/work')).toThrow('agent_session_conflict')
})
