import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { agentLaunchFixture, agentLaunchHostFixture } from './agent-launch-test-fixtures'
import { RuntimeRpcFailureError } from './runtime/types'

describe('cwd workspace ownership at the real CLI boundary', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })
  beforeEach(() => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
    vi.stubEnv('ORCA_STRUCTURED_SESSION', undefined)
  })
  afterEach(() => vi.unstubAllEnvs())
  const root = buildWorktree('/tmp/owner-choice', 'main', 'abc', 'repo-a')
  const sibling = { ...root, id: `${root.id}::workspace:11111111-1111-4111-8111-111111111111` }
  const choices = [root, sibling].map(({ id }) => `id:${id}`)
  const automation = [
    'automations',
    'create',
    '--name',
    'daily',
    '--trigger',
    'daily',
    '--prompt',
    'review',
    '--provider',
    'codex'
  ]

  it.each([false, true])(
    'refuses immediate consumers with exact recovery and no action (json=%s)',
    async (json) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const prior = process.exitCode
      const commands = [
        ['worktree', 'current'],
        ['worktree', 'show', '--worktree', 'current'],
        ['worktree', 'set', '--worktree', 'current', '--comment', 'keep'],
        ['worktree', 'set', '--worktree', choices[0]!, '--parent-worktree', 'active'],
        ...['active', 'current'].map((parent) => [
          'worktree',
          'create',
          '--repo',
          'id:repo-a',
          '--name',
          'child',
          '--parent-worktree',
          parent
        ]),
        ['snapshot'],
        ['snapshot', '--worktree', 'current'],
        ['tab', 'list'],
        ['terminal', 'read'],
        ['file', 'open', 'README.md'],
        ['emulator', 'list'],
        automation,
        ['computer', 'get-app-state', '--app', 'fixture'],
        ['orchestration', 'check', '--peek'],
        ['orchestration', 'run-current'],
        ['worktree', 'rm', '--worktree', 'current', '--force'],
        ['terminal', 'stop', '--worktree', 'current'],
        ['terminal', 'close', '--all', '--worktree', 'current'],
        [
          'connector',
          'start',
          '--conversation',
          'c',
          '--delivery-id',
          'd',
          '--agent',
          'codex',
          '--prompt',
          'hi',
          '--worktree',
          'current'
        ]
      ]
      try {
        for (const rows of [
          [root, sibling],
          [sibling, root]
        ]) {
          for (const args of commands) {
            callMock.mockReset()
            log.mockClear()
            err.mockClear()
            process.exitCode = prior
            callMock.mockResolvedValue(worktreeListFixture(rows))
            await main([...args, ...(json ? ['--json'] : [])], root.path)
            // Concise orchestration failures put the one-line error on stderr and the detail on stdout.
            const output = (json ? log : err).mock.calls
              .concat(json ? [] : log.mock.calls)
              .flat()
              .join('\n')
            expect(process.exitCode, JSON.stringify({ args, output })).toBe(1)
            if (json) {
              expect(JSON.parse(output).error.code, JSON.stringify(args)).toBe('selector_ambiguous')
              expect(JSON.parse(output).error.data.workspaces).toHaveLength(2)
            }
            for (const choice of choices) {
              expect(output).toContain(choice)
            }
            const advice = json
              ? JSON.parse(output).error.data.nextSteps.join(' ')
              : output.split('Next step:').slice(1).join(' ')
            if (args[0] === 'orchestration') {
              const steps = [
                'This command needs your own caller identity; selecting a target workspace cannot supply it.',
                'Run the command in your own live Orca terminal with ORCA_TERMINAL_HANDLE preserved.'
              ]
              expect(
                json
                  ? JSON.parse(output).error.data.nextSteps
                  : output.split('\nNext step: ').slice(1)
              ).toEqual(steps)
              expect(advice).not.toMatch(/--worktree|--parent-worktree|--from|worktree show/)
              expect(
                output.match(/More than one Orca workspace matched the current directory/g)
              ).toHaveLength(1)
              expect(log).toHaveBeenCalledTimes(1)
              expect(err.mock.calls).toEqual([
                [
                  'error: selector_ambiguous: More than one Orca workspace matched the current directory. Choose an exact workspace.'
                ]
              ])
              if (json) {
                expect(JSON.parse(output).error.data.workspaces).toEqual(
                  rows.map((row) => ({
                    id: row.id,
                    path: row.path,
                    hostId: 'local',
                    selector: `id:${row.id}`
                  }))
                )
              } else {
                expect(output.match(/Workspace choices \(JSON data\):/g)).toHaveLength(1)
              }
            } else {
              expect(output).toContain('worktree show --worktree')
              expect(advice).toContain(
                args.includes('--parent-worktree')
                  ? '--parent-worktree <selector>'
                  : args === automation
                    ? '--workspace <selector>'
                    : args[1] === 'current'
                      ? 'current has no replacement target flag'
                      : '--worktree <selector>'
              )
            }
            if (!args.includes('--parent-worktree')) {
              expect(advice).not.toContain('--parent-worktree')
            }
            expect(output).not.toContain('No Orca workspace matched')
            expect(output).not.toContain('orca repo list')
            expect(
              callMock.mock.calls.map(([method]) => method),
              JSON.stringify(args)
            ).toEqual(['worktree.list'])
          }
        }
      } finally {
        process.exitCode = prior
      }
    }
  )

  it.each([false, true])(
    'recovers with the own caller before cwd inference (json=%s)',
    async (json) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const prior = process.exitCode
      const own = 'term_owner_choice'
      const message = { id: 'message-own', from_handle: own, subject: 'own caller ready', read: 0 }
      const run = { id: 'run-own', objective: 'own caller run' }
      const controls = [
        {
          args: ['orchestration', 'check', '--peek'],
          env: own,
          method: 'orchestration.check',
          identity: 'terminal'
        },
        {
          args: ['orchestration', 'check', '--peek', '--terminal', own],
          env: undefined,
          method: 'orchestration.check',
          identity: 'terminal'
        },
        {
          args: ['orchestration', 'run-current'],
          env: own,
          method: 'orchestration.runCurrent',
          identity: 'from'
        },
        {
          args: ['orchestration', 'run-current', '--from', own],
          env: undefined,
          method: 'orchestration.runCurrent',
          identity: 'from'
        }
      ]
      try {
        for (const rows of [
          [root, sibling],
          [sibling, root]
        ]) {
          for (const { args, env, method: action, identity } of controls) {
            vi.stubEnv('ORCA_TERMINAL_HANDLE', env)
            callMock.mockReset()
            log.mockClear()
            err.mockClear()
            process.exitCode = prior
            callMock.mockImplementation(async (method) => {
              if (method === 'worktree.list') {
                return worktreeListFixture(rows)
              }
              if (method === 'terminal.resolveIdentity') {
                return okFixture('identity', { identity: { handle: own, live: true } })
              }
              return action === 'orchestration.check'
                ? okFixture('check', { messages: [message], count: 1 })
                : okFixture('run', { run })
            })
            await main([...args, ...(json ? ['--json'] : [])], root.path)
            const output = log.mock.calls.flat().join('\n')
            expect(process.exitCode, JSON.stringify({ args, output })).toBe(prior)
            expect(err).not.toHaveBeenCalled()
            expect(callMock.mock.calls.map(([method]) => method)).toEqual(
              env && identity === 'from' ? ['terminal.resolveIdentity', action] : [action]
            )
            if (env && identity === 'from') {
              expect(callMock).toHaveBeenCalledWith('terminal.resolveIdentity', { terminal: own })
            }
            expect(callMock).toHaveBeenCalledWith(
              action,
              expect.objectContaining({ [identity]: own })
            )
            if (json) {
              const response = JSON.parse(output)
              expect(response.ok).toBe(true)
              if (identity === 'terminal') {
                expect(response.result.messages).toMatchObject([
                  { id: message.id, from: own, subject: message.subject }
                ])
              } else {
                expect(response.result).toMatchObject({ runId: run.id, objective: run.objective })
              }
            } else {
              expect(output).toContain(
                identity === 'terminal' ? message.subject : `runId=${run.id}`
              )
            }
            expect(callMock).not.toHaveBeenCalledWith('worktree.list', expect.anything())
            expect(callMock).not.toHaveBeenCalledWith('terminal.resolveActive', expect.anything())
          }
        }
      } finally {
        process.exitCode = prior
      }
    }
  )

  it('preserves duplicate/unique/caller/nested elections and exact bypasses through printed output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const prior = process.exitCode
    const nested = buildWorktree(`${root.path}/nested`, 'child', 'abc', root.repoId)
    try {
      for (const { rows, owner, caller } of [
        { rows: [root], owner: root },
        { rows: [root, { ...root }], owner: root },
        { rows: [root, sibling], owner: sibling, caller: sibling.id },
        { rows: [sibling, root], owner: sibling, caller: sibling.id },
        { rows: [root, nested], owner: nested, caller: root.id }
      ]) {
        if (caller) {
          process.env.ORCA_WORKTREE_ID = caller
        } else {
          delete process.env.ORCA_WORKTREE_ID
        }
        callMock.mockReset()
        log.mockClear()
        callMock.mockImplementation(async (method) =>
          method === 'worktree.list'
            ? worktreeListFixture(rows)
            : okFixture('show', { worktree: owner })
        )
        await main(['worktree', 'current', '--json'], `${owner.path}/src`)
        expect(process.exitCode).toBe(prior)
        expect(callMock).toHaveBeenCalledWith('worktree.show', { worktree: `id:${owner.id}` })
        expect(JSON.parse(String(log.mock.calls[0]?.[0])).result.worktree.id).toBe(owner.id)
      }
      delete process.env.ORCA_WORKTREE_ID
      for (const args of [
        ['worktree', 'show', '--worktree', choices[0]!],
        ['snapshot', '--page', 'page-1'],
        ['terminal', 'read', '--terminal', 'term-1']
      ]) {
        callMock.mockReset()
        log.mockClear()
        callMock.mockResolvedValue(
          okFixture('explicit', { worktree: root, terminal: { text: 'ready' }, snapshot: 'ready' })
        )
        await main([...args, '--json'], root.path)
        expect(process.exitCode).toBe(prior)
        expect(callMock).not.toHaveBeenCalledWith('worktree.list', expect.anything())
        expect(log.mock.calls.flat().join('')).toContain('"ok": true')
      }
    } finally {
      process.exitCode = prior
    }
  })

  it('reaches exact and unique-current connector/start-stop-close results through main', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const prior = process.exitCode
    const cases = [
      {
        argv: [
          'connector',
          'start',
          '--conversation',
          'fixture',
          '--delivery-id',
          'delivery',
          '--agent',
          'codex',
          '--prompt',
          'hello'
        ],
        method: 'connector.start',
        result: { initial: { outcome: 'accepted' } },
        text: 'started; prompt accepted'
      },
      {
        argv: ['terminal', 'stop'],
        method: 'terminal.stop',
        result: { stopped: 3 },
        text: 'Stopped 3 terminals.'
      },
      {
        argv: ['terminal', 'close', '--all'],
        method: 'terminal.closeAll',
        result: { closed: 2, stopped: 3, retiredSurfaces: true },
        text: 'Closed 2 terminal tabs and stopped 3 terminal processes.'
      }
    ]
    try {
      for (const entry of cases) {
        for (const exact of [true, false]) {
          for (const json of [false, true]) {
            callMock.mockReset()
            log.mockClear()
            callMock.mockImplementation(async (method) =>
              method === 'worktree.list'
                ? worktreeListFixture(exact ? [root, sibling] : [root])
                : okFixture(entry.method, entry.result)
            )
            await main(
              [
                ...entry.argv,
                '--worktree',
                exact ? choices[0]! : 'current',
                ...(json ? ['--json'] : [])
              ],
              root.path
            )
            expect(process.exitCode).toBe(prior)
            const downstream = callMock.mock.calls.filter(([method]) => method === entry.method)
            expect(downstream).toHaveLength(1)
            expect(downstream[0]?.[1]).toMatchObject(
              entry.method === 'connector.start'
                ? {
                    target: { kind: 'existing', worktree: choices[0] },
                    prompt: 'hello',
                    agent: 'codex'
                  }
                : { worktree: choices[0] }
            )
            expect(
              callMock.mock.calls.filter(([method]) => method === 'worktree.list')
            ).toHaveLength(exact ? 0 : 1)
            const output = log.mock.calls.flat().join('\n')
            if (json) {
              expect(JSON.parse(output).result).toEqual(entry.result)
            } else {
              expect(output).toBe(entry.text)
            }
          }
        }
      }
    } finally {
      process.exitCode = prior
    }
  })

  it('ignores stale or non-containing caller identities instead of breaking a positive owner tie', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const prior = process.exitCode
    const outside = buildWorktree('/tmp/outside-choice', 'main', 'abc', root.repoId)
    try {
      for (const caller of ['stale', outside.id]) {
        for (const rows of [
          [root, sibling, outside],
          [outside, sibling, root]
        ]) {
          process.env.ORCA_WORKTREE_ID = caller
          callMock.mockReset()
          log.mockClear()
          process.exitCode = prior
          callMock.mockResolvedValue(worktreeListFixture(rows))
          await main(['worktree', 'current', '--json'], root.path)
          expect(process.exitCode).toBe(1)
          expect(
            JSON.parse(log.mock.calls.flat().join('\n')).error.data.validSelectorForms
          ).toEqual(rows.filter((row) => row !== outside).map((row) => `id:${row.id}`))
          expect(callMock).toHaveBeenCalledTimes(1)
        }
      }
    } finally {
      process.exitCode = prior
    }
  })

  it('retains optional no-match/unavailable fallback and deliberate scope bypasses', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const prior = process.exitCode
    const commands = [
      { args: ['snapshot'], method: 'browser.snapshot' },
      { args: ['emulator', 'list'], method: 'emulator.list' },
      { args: automation, method: 'automation.create' }
    ]
    try {
      for (const { args, method: action } of commands) {
        for (const mode of ['missing', 'unavailable', 'exact', 'remote']) {
          callMock.mockReset()
          log.mockClear()
          process.exitCode = prior
          callMock.mockImplementation(async (method) => {
            if (method === 'worktree.list') {
              if (mode === 'unavailable') {
                throw new RuntimeRpcFailureError({
                  id: 'unavailable',
                  ok: false,
                  error: { code: 'runtime_unavailable', message: 'unavailable' },
                  _meta: { runtimeId: 'runtime-1' }
                })
              }
              return worktreeListFixture([])
            }
            if (method === 'worktree.show') {
              return okFixture('show', { worktree: root })
            }
            if (method === 'repo.show') {
              return okFixture('repo', { repo: { id: root.repoId, connectionId: null } })
            }
            return okFixture('accepted', { marker: 'accepted' })
          })
          const scope =
            mode === 'exact'
              ? [action === 'automation.create' ? '--workspace' : '--worktree', choices[0]!]
              : mode === 'remote'
                ? ['--pairing-code', 'remote-runtime']
                : []
          await main([...args, ...scope, '--json'], root.path)
          expect(process.exitCode, JSON.stringify({ args, mode, output: log.mock.calls })).toBe(
            prior
          )
          expect(callMock).toHaveBeenCalledWith(
            action,
            expect.objectContaining({
              [action === 'automation.create' ? 'workspace' : 'worktree']:
                mode === 'exact' ? choices[0] : undefined
            })
          )
          expect(JSON.parse(log.mock.calls.flat().join('\n')).result.marker).toBe('accepted')
          expect(callMock.mock.calls.filter(([method]) => method === 'worktree.list')).toHaveLength(
            mode === 'exact' || mode === 'remote' ? 0 : 1
          )
          if (mode === 'unavailable') {
            await expect(callMock.mock.results[0]?.value).rejects.toBeInstanceOf(
              RuntimeRpcFailureError
            )
            await expect(callMock.mock.results[0]?.value).rejects.toMatchObject({
              code: 'runtime_unavailable'
            })
          }
        }
      }
      for (const args of [
        ['snapshot', '--worktree', 'all'],
        ['emulator', 'list', '--worktree', 'all'],
        ['computer', 'get-app-state', '--app', 'fixture', '--session', 'session-1'],
        ['file', 'open', 'README.md', '--worktree', choices[0]!]
      ]) {
        callMock.mockReset()
        log.mockClear()
        process.exitCode = prior
        callMock.mockResolvedValue(okFixture('explicit', { marker: 'accepted', opened: true }))
        await main([...args, '--json'], root.path)
        expect(process.exitCode).toBe(prior)
        expect(callMock).not.toHaveBeenCalledWith('worktree.list', expect.anything())
        expect(JSON.parse(log.mock.calls.flat().join('\n')).result.marker).toBe('accepted')
      }
    } finally {
      process.exitCode = prior
    }
  })

  it('carries only consumed implicit choices, keeping exact/no-parent creation and separate project inference', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const prior = process.exitCode
    try {
      for (const rows of [
        [root, sibling],
        [sibling, root]
      ]) {
        for (const parent of [[], ['--parent-worktree', choices[1]!], ['--no-parent']]) {
          callMock.mockReset()
          log.mockClear()
          callMock.mockImplementation(async (method) =>
            method === 'worktree.list'
              ? worktreeListFixture(rows)
              : okFixture('create', { worktree: root, lineage: null, warnings: [] })
          )
          await main(['worktree', 'create', '--name', 'child', ...parent, '--json'], root.path)
          expect(process.exitCode).toBe(prior)
          const params = callMock.mock.calls.find(([method]) => method === 'worktree.create')?.[1]
          expect(params).toMatchObject({ repo: 'id:repo-a', cliProvenanceRequest: {} })
          if (parent.length === 0) {
            expect(params).toMatchObject({
              cwdParentWorktree: `id:${rows[0]!.id}`,
              cwdParentAmbiguous: true
            })
          } else {
            expect(params).not.toHaveProperty('cwdParentAmbiguous')
            expect(params).not.toHaveProperty('cwdParentWorktree')
          }
          expect(JSON.parse(String(log.mock.calls[0]?.[0])).result.worktree.id).toBe(root.id)
        }
      }
      callMock.mockReset()
      callMock.mockResolvedValue(
        okFixture('create', { worktree: root, lineage: null, warnings: [] })
      )
      await main(
        ['worktree', 'create', '--repo', 'id:repo-a', '--no-parent', '--name', 'child', '--json'],
        root.path
      )
      expect(callMock.mock.calls.map(([method]) => method)).toEqual(['worktree.create'])
    } finally {
      process.exitCode = prior
    }
  })

  it.each([false, true])(
    'exposes eligible native choices once after host/caller election (json=%s)',
    async (json) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const prior = process.exitCode
      try {
        for (const command of [
          ['agent', 'launch', '--agent', 'codex'],
          ['ports', '--all']
        ]) {
          for (const caller of [undefined, 'folder:r']) {
            for (const ids of [
              ['r', 's', 'remote'],
              ['remote', 's', 'r']
            ]) {
              callMock.mockReset()
              log.mockClear()
              err.mockClear()
              process.exitCode = prior
              if (caller) {
                process.env.ORCA_WORKSPACE_ID = caller
              } else {
                delete process.env.ORCA_WORKSPACE_ID
              }
              callMock.mockImplementation(async (method) => {
                if (method === 'folderWorkspace.list') {
                  return okFixture('folders', {
                    folderWorkspaces: ids.map((id) => ({
                      id,
                      folderPath: root.path,
                      projectGroupId: id === 'remote' ? 'ssh' : 'local'
                    }))
                  })
                }
                if (method === 'projectGroup.list') {
                  return okFixture('groups', {
                    groups: [{ id: 'local' }, { id: 'ssh', connectionId: 'other' }]
                  })
                }
                if (method === 'repo.list') {
                  return okFixture('repos', { repos: [] })
                }
                if (method === 'status.get') {
                  return agentLaunchHostFixture()
                }
                if (method === 'workspacePorts.scanHost') {
                  return okFixture('ports', { ports: [] })
                }
                return agentLaunchFixture('folder:r')
              })
              await main([...command, ...(json ? ['--json'] : [])], root.path)
              expect(callMock.mock.calls.slice(0, 3).map(([method]) => method)).toEqual([
                'folderWorkspace.list',
                'projectGroup.list',
                'repo.list'
              ])
              expect(callMock).not.toHaveBeenCalledWith('worktree.list', expect.anything())
              if (caller) {
                expect(process.exitCode, log.mock.calls.flat().join('')).toBe(prior)
                expect(callMock).toHaveBeenCalledWith(
                  command[0] === 'ports' ? 'workspacePorts.scanHost' : 'agent.launchReplay',
                  command[0] === 'ports'
                    ? { worktree: 'id:folder:r' }
                    : expect.objectContaining({
                        target: { kind: 'existing', worktree: 'id:folder:r' }
                      })
                )
              } else {
                expect(process.exitCode).toBe(1)
                const output = (json ? log : err).mock.calls.flat().join('\n')
                const choices = json
                  ? JSON.parse(output).error.data.workspaces
                  : JSON.parse(
                      output.split('Workspace choices (JSON data):\n')[1]!.split('\nNext step:')[0]!
                    )
                expect(choices.map((choice: { selector: string }) => choice.selector)).toEqual(
                  ids.filter((id) => id !== 'remote').map((id) => `id:folder:${id}`)
                )
                expect(
                  choices.every((choice: { hostId: string }) => choice.hostId === 'local')
                ).toBe(true)
                expect(output).not.toContain('worktree list')
                expect(output).toContain(
                  command[0] === 'ports' ? 'The port scan did not run.' : 'codex was not started.'
                )
                expect(output).toContain('--worktree <selector>')
                if (!json) {
                  expect(output.split('Workspace choices (JSON data):')).toHaveLength(2)
                }
                expect(callMock).toHaveBeenCalledTimes(3)
              }
            }
          }
        }
      } finally {
        process.exitCode = prior
      }
    }
  )
  it.each([
    'space path',
    'quotes" and smart“quotes”',
    'semi;&$`%!^()',
    'back\\slash/',
    'line\nfeed',
    'cafe\u0301'
  ])('shows raw choice data once and accepts it as one selector argument: %j', async (suffix) => {
    const row = buildWorktree(`/tmp/owner ${suffix}`, 'main', 'abc', 'repo-a')
    const other = { ...row, id: `${row.id}::workspace:sibling` }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prior = process.exitCode
    try {
      for (const json of [false, true]) {
        log.mockClear()
        err.mockClear()
        process.exitCode = prior
        callMock.mockResolvedValue(worktreeListFixture([row, other]))
        await main(['worktree', 'current', ...(json ? ['--json'] : [])], row.path)
        expect(process.exitCode).toBe(1)
        const output = (json ? log : err).mock.calls.flat().join('\n')
        const data = json
          ? JSON.parse(output).error.data.workspaces
          : JSON.parse(
              output.split('Workspace choices (JSON data):\n')[1]!.split('\nNext step:')[0]!
            )
        expect(data.map((choice: { selector: string }) => choice.selector)).toEqual([
          `id:${row.id}`,
          `id:${other.id}`
        ])
        if (!json) {
          expect(output.split('Workspace choices (JSON data):')).toHaveLength(2)
        }
        const advice = json
          ? JSON.parse(output).error.data.nextSteps.join(' ')
          : output.split('Next step:').slice(1).join(' ')
        expect(advice).not.toContain(row.id)
        expect(advice).toContain('one argument quoted for your shell')
        log.mockClear()
        process.exitCode = prior
        callMock.mockReset()
        callMock.mockResolvedValue(okFixture('exact', { worktree: row }))
        await main(['worktree', 'show', '--worktree', data[0].selector, '--json'], row.path)
        expect(process.exitCode).toBe(prior)
        expect(callMock.mock.calls).toEqual([['worktree.show', { worktree: `id:${row.id}` }]])
        expect(JSON.parse(log.mock.calls.flat().join('')).result.worktree.id).toBe(row.id)
      }
    } finally {
      process.exitCode = prior
    }
  })
})
