import type { RuntimeArtifactController } from './runtime-artifact-controller'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeFileCommands } from './orca-runtime-files'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeFileAccess } from './files/file-access'
import { RuntimeFileReads } from './files/file-reads'
import { RuntimeTerminalArtifacts } from './terminal/artifacts/terminal-artifacts'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import type { RuntimeFileCommandHost } from './files/file-command-host'

const unexpectedHostRead = (): never => {
  throw new Error('unexpected_host_read')
}

const host = {
  getRuntimeId: () => 'artifact-facade',
  requireStore: unexpectedHostRead,
  resolveRuntimeFileTarget: async () => unexpectedHostRead(),
  resolveRuntimeGitTarget: async () => unexpectedHostRead(),
  openFile: unexpectedHostRead,
  openDiff: unexpectedHostRead
} satisfies RuntimeFileCommandHost

const reachedArtifactOwner = (): never => {
  throw new Error('artifact_owner_reached')
}

afterEach(() => vi.restoreAllMocks())

it('preserves artifact optional slots and the same artifact receiver', () => {
  const read = vi
    .spyOn(RuntimeTerminalArtifacts.prototype, 'readTerminalArtifactFile')
    .mockImplementation(reachedArtifactOwner)
  const preview = vi
    .spyOn(RuntimeTerminalArtifacts.prototype, 'readTerminalArtifactPreview')
    .mockImplementation(reachedArtifactOwner)
  const write = vi
    .spyOn(RuntimeTerminalArtifacts.prototype, 'writeTerminalArtifactFile')
    .mockImplementation(reachedArtifactOwner)
  const revoke = vi
    .spyOn(RuntimeTerminalArtifacts.prototype, 'revokeTerminalFileGrantsForClient')
    .mockImplementation(reachedArtifactOwner)
  const commands = new RuntimeFileCommands(host)

  expect(() => commands.readTerminalArtifactFile('worktree', 'grant', '/artifact')).toThrow(
    'artifact_owner_reached'
  )
  expect(() =>
    commands.readTerminalArtifactFile('worktree', 'grant', '/artifact', undefined)
  ).toThrow('artifact_owner_reached')
  expect(read.mock.calls).toEqual([
    ['worktree', 'grant', '/artifact', undefined],
    ['worktree', 'grant', '/artifact', undefined]
  ])

  expect(() => commands.readTerminalArtifactPreview('worktree', 'grant', '/artifact')).toThrow(
    'artifact_owner_reached'
  )
  expect(() =>
    commands.readTerminalArtifactPreview('worktree', 'grant', '/artifact', undefined, undefined)
  ).toThrow('artifact_owner_reached')
  expect(preview.mock.calls).toEqual([
    ['worktree', 'grant', '/artifact', undefined, undefined],
    ['worktree', 'grant', '/artifact', undefined, undefined]
  ])

  expect(() =>
    commands.writeTerminalArtifactFile('worktree', 'grant', '/artifact', 'text')
  ).toThrow('artifact_owner_reached')
  expect(() =>
    commands.writeTerminalArtifactFile('worktree', 'grant', '/artifact', 'text', undefined)
  ).toThrow('artifact_owner_reached')
  expect(write.mock.calls).toEqual([
    ['worktree', 'grant', '/artifact', 'text', undefined],
    ['worktree', 'grant', '/artifact', 'text', undefined]
  ])

  expect(() => commands.revokeTerminalFileGrantsForClient('client')).toThrow(
    'artifact_owner_reached'
  )
  expect(revoke.mock.calls).toEqual([['client']])
  const owner = read.mock.contexts[0]
  expect(owner).toBeInstanceOf(RuntimeTerminalArtifacts)
  for (const context of [read, preview, write, revoke].flatMap((spy) => spy.mock.contexts)) {
    expect(context).toBe(owner)
  }
})

it.each(['command facade', 'installed runtime'])(
  'forwards omitted file arguments and optional positions through the %s',
  (surface) => {
    const returned: ReturnType<RuntimeFileAccess['openMobileFile']> = Promise.resolve({
      worktree: 'worktree',
      relativePath: 'file',
      kind: 'text',
      opened: true
    })
    const open = vi.spyOn(RuntimeFileAccess.prototype, 'openMobileFile').mockReturnValue(returned)
    const commands =
      surface === 'command facade' ? new RuntimeFileCommands(host) : new OrcaRuntimeService(null)
    const position = { line: 12, column: 5 }

    expect(commands.openMobileFile('worktree', 'file')).toBe(returned)
    expect(commands.openMobileFile('worktree', 'file', 'caller')).toBe(returned)
    expect(commands.openMobileFile('worktree', 'file', undefined, position)).toBe(returned)
    expect(commands.openMobileFile('worktree', 'file', undefined, undefined)).toBe(returned)
    expect(open.mock.calls).toEqual([
      ['worktree', 'file'],
      ['worktree', 'file', 'caller'],
      ['worktree', 'file', undefined, position],
      ['worktree', 'file', undefined, undefined]
    ])
    const owner = open.mock.contexts[0]
    expect(owner).toBeInstanceOf(RuntimeFileAccess)
    for (const context of open.mock.contexts) {
      expect(context).toBe(owner)
    }
  }
)

it('preserves omitted argument slots, owner receivers, and the returned promise', () => {
  const returned: ReturnType<RuntimeFileReads['readFileExplorerPreview']> = Promise.resolve({
    content: 'bound-owner',
    isBinary: false
  })
  const read = vi
    .spyOn(RuntimeFileReads.prototype, 'readFileExplorerPreview')
    .mockImplementation(function (this: RuntimeFileReads) {
      return returned
    })
  const runtime = new OrcaRuntimeService(null)

  expect(runtime.readFileExplorerPreview('worktree', 'file')).toBe(returned)
  expect(runtime.readFileExplorerPreview('worktree', 'file', undefined)).toBe(returned)
  expect(read.mock.calls).toEqual([
    ['worktree', 'file'],
    ['worktree', 'file', undefined]
  ])
  expect(read.mock.contexts[0]).toBeInstanceOf(RuntimeFileReads)
  expect(read.mock.contexts[1]).toBe(read.mock.contexts[0])

  const replacement: ReturnType<RuntimeFileReads['readFileExplorerPreview']> = Promise.resolve({
    content: 'runtime-override',
    isBinary: false
  })
  vi.spyOn(runtime, 'readFileExplorerPreview').mockReturnValueOnce(replacement)
  expect(runtime.readFileExplorerPreview('other-worktree', 'other-file')).toBe(replacement)
  expect(read).toHaveBeenCalledTimes(2)
})

it('delegates artifact listing to the current owner with the original argument and promise', () => {
  const runtime = new OrcaRuntimeService(null)
  const owner = runtime['artifacts']
  const events: string[] = []
  const returned: ReturnType<RuntimeArtifactController['list']> = Promise.resolve({
    status: 'unconfigured',
    message: 'not connected'
  })
  const list = vi.spyOn(owner, 'list').mockImplementation(function (
    this: RuntimeArtifactController
  ) {
    events.push('list')
    expect(this).toBe(owner)
    expect(arguments.length).toBe(1)
    return returned
  })
  Object.defineProperty(runtime, 'artifacts', {
    get() {
      events.push('owner')
      return owner
    }
  })
  const options = { cursor: 'next', apiUrl: 'https://artifacts.example.test' }

  expect(runtime.listArtifacts(options)).toBe(returned)
  expect(list).toHaveBeenCalledExactlyOnceWith(options)
  expect(events).toEqual(['owner', 'list'])
})

it('replaces the database after clearing its old routing state and then uses runtime overrides', () => {
  const runtime = new OrcaRuntimeService(null)
  const first = new OrchestrationDb(':memory:')
  const second = new OrchestrationDb(':memory:')
  const events: string[] = []
  const dbAtCall: (OrchestrationDb | null)[] = []
  const record = (name: string) => {
    events.push(name)
    dbAtCall.push(runtime['_orchestrationDb'])
  }
  vi.spyOn(runtime['orchestrationFederation'], 'resetForDatabaseChange').mockImplementation(() =>
    record('reset')
  )
  vi.spyOn(runtime['mailPointerRepointScheduler'], 'clear').mockImplementation(() =>
    record('clear')
  )
  Object.defineProperties(runtime, {
    ensureOrchestrationFederationRelay: {
      value: function (this: OrcaRuntimeService) {
        expect(this).toBe(runtime)
        expect(arguments.length).toBe(0)
        record('relay')
      }
    },
    scheduleRestoredMessageRepoints: {
      value: function (this: OrcaRuntimeService) {
        expect(this).toBe(runtime)
        expect(arguments.length).toBe(0)
        record('repoint')
      }
    }
  })
  try {
    runtime.setOrchestrationDb(first)
    events.length = 0
    dbAtCall.length = 0
    runtime.setOrchestrationDb(second)

    expect(events).toEqual(['reset', 'clear', 'relay', 'repoint'])
    expect(dbAtCall).toEqual([first, first, second, second])
    expect(runtime.getOrchestrationDb()).toBe(second)
    expect(runtime.getExistingOrchestrationDb()).toBe(second)
    expect(events).toEqual(['reset', 'clear', 'relay', 'repoint'])
  } finally {
    first.close()
    second.close()
  }
})
