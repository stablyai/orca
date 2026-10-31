import * as fs from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { join, relative } from 'node:path'
import { expect, it, vi } from 'vitest'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { generateConversationNameFromContext } from './commit-message-text-generation'
import { discoverModelsLocal } from './commit-message-model-discovery'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { _setGuestWindowsDriveMountsForTests } from '../ipc/wsl-guest-windows-drive-path'
import type { AttemptEvent } from './source-control-agent-cli-scaling.test-fixture'

const { mkdirSync, writeFileSync, readFileSync, symlinkSync } = fs

type HomeFixture = { specs: ProcessSpec[]; children: ChildProcess[] }

function agent(home: string, folder: string, command: string, title: string): string {
  const bin = join(home, folder)
  mkdirSync(bin, { recursive: true })
  const program = join(bin, command)
  writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' ${quotePosixShell(title)}\n`, { mode: 0o755 })
  return program
}

export function installedNamingHomeContract(
  rootPath: () => string,
  fixture: HomeFixture,
  readEvents: () => AttemptEvent[]
): void {
  const request = async (
    command: string,
    env: NodeJS.ProcessEnv,
    cwd = rootPath(),
    agentId: 'custom' | 'codex' | 'claude' = 'custom'
  ) => {
    const before = fixture.children.length
    const result = await generateConversationNameFromContext(
      { firstPrompt: 'Fix login' },
      {
        agentId,
        model: agentId === 'custom' ? '' : agentId === 'codex' ? 'default' : 'sonnet',
        ...(agentId === 'custom' ? { customAgentCommand: command } : {})
      },
      { kind: 'local', cwd, env: { PATH: join(rootPath(), 'empty-path'), ...env } }
    )
    // Production generation publishes its final result from the supervisor close event.
    expect(fixture.children.length - before).toBe(1)
    const child = fixture.children.at(-1)!
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(child.listenerCount('message')).toBe(0)
    return result
  }

  it.each(['codex', 'claude'] as const)(
    'finds an nvm %s in a distinct target HOME with its sibling Node',
    async (agentId) => {
      const root = rootPath(),
        home = join(root, 'target')
      const bin = join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin')
      mkdirSync(bin, { recursive: true })
      symlinkSync(process.execPath, join(bin, 'node'))
      const program = join(bin, agentId)
      writeFileSync(program, "#!/usr/bin/env node\nconsole.log('Fix login flow')\n", {
        mode: 0o755
      })
      agent(root, '.local/bin', agentId, 'Wrong parent CLI')
      expect(home).not.toBe(process.env.HOME)
      await expect(request(agentId, { HOME: home }, home, agentId)).resolves.toMatchObject({
        success: true,
        name: 'Fix login flow',
        agentLabel: agentId === 'codex' ? 'Codex' : 'Claude'
      })
      expect(readEvents().filter((event) => event.started)).toEqual([
        expect.objectContaining({ started: program })
      ])
    }
  )

  it.each([
    ['./node_modules/.bin:EMPTY', 'node_modules/.bin'],
    [':EMPTY', '.'],
    ['EMPTY:', '.']
  ])('resolves recipe PATH %s from the workspace before global installs', async (path, folder) => {
    const home = join(rootPath(), 'workspace')
    agent(home, folder, 'codex', 'Project CLI')
    agent(home, '.local/bin', 'codex', 'Wrong global CLI')
    await expect(
      request(
        `PATH=${path.replace('EMPTY', join(home, 'empty-path'))} codex`,
        {
          HOME: home
        },
        home
      )
    ).resolves.toMatchObject({ success: true, name: 'Project CLI' })
    expect(asyncFs.readdir).not.toHaveBeenCalled()
  })

  it.each(['codex', 'claude'] as const)(
    'uses the recipe HOME before target/parent/config decoys and preserves %s account inputs',
    async (command) => {
      const root = rootPath(),
        target = join(root, 'target'),
        home = join(root, 'recipe')
      const config = join(root, 'account'),
        observed = join(root, 'observed.json')
      for (const decoy of [root, target, config]) {
        agent(decoy, '.local/bin', command, 'Wrong home CLI')
      }
      const program = agent(home, '.local/bin', command, 'Recipe title')
      symlinkSync(process.execPath, join(home, '.local/bin/node'))
      writeFileSync(
        program,
        `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.OBSERVED, JSON.stringify({home:process.env.HOME,codex:process.env.CODEX_HOME,claude:process.env.CLAUDE_CONFIG_DIR,deleted:process.env.DELETED,args:process.argv.slice(2)}))
console.log('Recipe title')
`
      )
      await expect(
        request(`HOME=${quotePosixShell(home)} ${command} --account chosen`, {
          HOME: target,
          CODEX_HOME: config,
          CLAUDE_CONFIG_DIR: config,
          DELETED: undefined,
          OBSERVED: observed
        })
      ).resolves.toMatchObject({ success: true, name: 'Recipe title' })
      expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
        home,
        codex: config,
        claude: config,
        args: ['--account', 'chosen']
      })
      expect(readEvents().filter((event) => event.started)).toEqual([
        expect.objectContaining({ started: program })
      ])
      expect(vi.mocked(asyncFs.readdir).mock.calls.map(([path]) => String(path))).toEqual([
        `${home}/.nvm/versions/node`
      ])
    }
  )

  it('never adds parent/config catalogs for defined HOME, but defaults an absent/deleted HOME', async () => {
    const root = rootPath(),
      home = join(root, 'empty-home'),
      config = join(root, 'config')
    const command = 'orca-home-contract'
    const parent = agent(root, '.local/bin', command, 'Parent title')
    agent(config, '.local/bin', command, 'Wrong config title')
    const env = { CODEX_HOME: config, CLAUDE_CONFIG_DIR: config }
    await expect(request(command, { ...env, HOME: home })).resolves.toMatchObject({
      success: false
    })
    expect(readEvents().some((event) => event.attempt === parent)).toBe(false)
    for (const homeEnv of [{}, { HOME: undefined }]) {
      await expect(request(command, { ...env, ...homeEnv })).resolves.toMatchObject({
        success: true,
        name: 'Parent title'
      })
      expect(fixture.specs.at(-1)?.env?.HOME).toBeUndefined()
    }
  })

  it.each(['', 'relative-home', ' space ', '~'])(
    'anchors literal HOME %j to the actual cwd for both matching and different parent cwd',
    async (home) => {
      const root = rootPath(),
        cwd = join(root, 'workspace')
      const command = 'orca-relative-home'
      const childRoot = home ? `${cwd}/${home}` : cwd
      const program = agent(childRoot, '.local/bin', command, 'Child cwd title')
      agent(home ? `${root}/${home}` : root, '.local/bin', command, 'Wrong parent cwd')
      const previousCwd = process.cwd()
      try {
        for (const parentCwd of [cwd, root]) {
          process.chdir(parentCwd)
          await expect(request(command, { HOME: home }, cwd)).resolves.toMatchObject({
            success: true,
            name: 'Child cwd title'
          })
          expect(fixture.specs.at(-1)?.env?.HOME).toBe(home)
          expect(readEvents().findLast((event) => event.started)?.started).toBe(program)
        }
      } finally {
        process.chdir(previousCwd)
      }
    }
  )

  it.each(['HOME prefix', 'cwd prefix'])(
    'preserves a symlink/.. %s through nvm default preference and sibling Node',
    async (kind) => {
      const root = rootPath(),
        actual = join(root, 'actual')
      mkdirSync(join(actual, 'nested'), { recursive: true })
      symlinkSync(join(actual, 'nested'), join(root, 'link'))
      const prefix = `${root}/link/..`
      const command = 'orca-prefix-contract'
      agent(root, '.nvm/versions/node/v20.1.0/bin', command, 'Wrong normalized home')
      agent(actual, '.nvm/versions/node/v24.1.0/bin', command, 'Wrong newest version')
      const realProgram = agent(actual, '.nvm/versions/node/v20.1.0/bin', command, 'Prefix title')
      symlinkSync(process.execPath, join(realProgram, '..', 'node'))
      writeFileSync(
        realProgram,
        `#!/bin/sh
exec node -e "console.log('Prefix title')"
`
      )
      mkdirSync(join(actual, '.nvm/alias/lts'), { recursive: true })
      writeFileSync(join(actual, '.nvm/alias/default'), 'lts/*')
      writeFileSync(join(actual, '.nvm/alias/lts/*'), '20')
      const program = `${prefix}/.nvm/versions/node/v20.1.0/bin/${command}`
      await expect(
        request(
          command,
          { HOME: kind === 'HOME prefix' ? prefix : '' },
          kind === 'cwd prefix' ? prefix : root
        )
      ).resolves.toMatchObject({ success: true, name: 'Prefix title' })
      expect(readEvents().filter((event) => event.started)).toEqual([
        expect.objectContaining({ started: program })
      ])
      expect(vi.mocked(asyncFs.readFile).mock.calls.map(([path]) => String(path))).toContain(
        `${prefix}/.nvm/alias/lts/*`
      )
      expect(fixture.specs.at(-1)?.cwd).toBe(kind === 'cwd prefix' ? prefix : root)
      expect(vi.mocked(asyncFs.stat).mock.calls.map(([path]) => String(path))).toContain(
        `${prefix}/.nvm/versions/node/v20.1.0/bin/node`
      )
    }
  )

  it.each(['absolute', 'relative'])(
    'excludes a guest-mounted %s child HOME before reads without parent substitution',
    async (kind) => {
      const root = rootPath(),
        mount = join(root, 'drive'),
        home = join(mount, 'home')
      const command = 'orca-guest-home'
      agent(root, '.local/bin', command, 'Wrong parent substitution')
      agent(home, '.local/bin', command, 'Forbidden title')
      _setGuestWindowsDriveMountsForTests([mount])
      const childHome = kind === 'absolute' ? home : relative(root, home)
      await expect(request(command, { HOME: childHome })).resolves.toMatchObject({ success: false })
      const reads = [
        asyncFs.readdir,
        asyncFs.stat,
        asyncFs.access,
        asyncFs.open,
        asyncFs.readFile
      ].flatMap((read) => vi.mocked(read).mock.calls.map(([path]) => String(path)))
      expect(reads.some((path) => path.startsWith(mount))).toBe(false)
      expect(reads.some((path) => path.startsWith(`${root}/.nvm`))).toBe(false)
      expect(readEvents().some((event) => event.attempt?.startsWith(root))).toBe(false)
      expect(readEvents().some((event) => event.attempt === `/usr/local/bin/${command}`)).toBe(true)
      const allowed = join(root, 'allowed')
      agent(allowed, '.local/bin', command, 'Allowed title')
      await expect(request(command, { HOME: allowed })).resolves.toMatchObject({
        success: true,
        name: 'Allowed title'
      })
    }
  )

  it('anchors model-discovery HOME at its actual process cwd, not the requested workspace', async () => {
    const root = rootPath(),
      actualCwd = join(root, 'process'),
      workspace = join(root, 'workspace')
    const home = 'relative-home',
      command = 'orca-model-home'
    agent(actualCwd, `${home}/.local/bin`, command, 'vendor/model')
    agent(workspace, `${home}/.local/bin`, command, 'wrong/model')
    const previousCwd = process.cwd()
    try {
      process.chdir(actualCwd)
      await expect(
        discoverModelsLocal({
          agentId: 'opencode',
          agentCommandOverride: command,
          env: { HOME: home, PATH: join(root, 'empty-path') },
          options: { cwd: workspace },
          backslash: 'escape',
          spawnAgent: spawnSourceControlAgent
        })
      ).resolves.toMatchObject({
        success: true,
        models: expect.arrayContaining([expect.objectContaining({ id: 'vendor/model' })])
      })
      expect(fixture.specs.at(-1)?.cwd).toBe(process.cwd())
      expect(fixture.children.at(-1)?.exitCode).toBe(0)
    } finally {
      process.chdir(previousCwd)
    }
  })
}
