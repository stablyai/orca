import { readFileSync, mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { resolveOxcCliInvocation } from './oxc-cli-invocation.mjs'

it('enforces five raw catalog forms with the actual config and narrow file exceptions', () => {
  const config = JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
  const jsPluginConfig = JSON.parse(readFileSync(resolve('config/oxlint-js-plugins.json'), 'utf8'))
  expect(config.ignorePatterns.every((pattern) => typeof pattern === 'string')).toBe(true)
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'sta-10541-catalog-rule-')))
  const source = `
    const key = 'projects';
    function read(state) {
      state.endpointProjects;
      state?.endpointProjectHostSetups;
      const { endpointProjects: projects } = state;
      state['endpointProjectHostSetups'];
      const key = 'endpointProjects'; state[key];
      { const key = 'projects'; state[key]; }
      function shadow(key) { return state[key]; }
      const unrelated = 'projectHostSetups'; state[unrelated];
      state.projects;
      state.projectHostSetups;
      return projects;
    }
  `
  try {
    writeFileSync(join(folder, 'config.json'), JSON.stringify(config))
    writeFileSync(
      join(folder, 'js-config.json'),
      JSON.stringify({
        ...jsPluginConfig,
        jsPlugins: jsPluginConfig.jsPlugins.map((plugin) => ({
          ...plugin,
          specifier: resolve('config', plugin.specifier)
        }))
      })
    )
    const lint = (file, content = source) => {
      const target = join(folder, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      return ['config.json', 'js-config.json'].flatMap((configFile) => {
        const invocation = resolveOxcCliInvocation('oxlint', 'oxlint')
        const result = spawnSync(
          invocation.command,
          [
            ...invocation.prefixArgs,
            '--config',
            join(folder, configFile),
            '--format',
            'json',
            file
          ],
          { cwd: folder, encoding: 'utf8' }
        )
        expect(result.error).toBeUndefined()
        const diagnostics = JSON.parse(result.stdout).diagnostics
        expect(result.stderr).toBe('')
        expect(JSON.parse(result.stdout).number_of_files, result.stdout).toBe(1)
        return diagnostics.filter(
          (entry) =>
            entry.code.includes('no-restricted-properties') ||
            entry.code.includes('no-raw-project-catalog-computed')
        )
      })
    }
    for (const file of [
      'src/renderer/src/hooks/useActiveProjectSkillRuntime.ts',
      'src/renderer/src/store/repos/repo-state.ts'
    ]) {
      const forbidden = lint(file)
      expect(forbidden).toHaveLength(5)
      expect(
        forbidden.filter((entry) => entry.code.includes('no-restricted-properties'))
      ).toHaveLength(4)
      expect(
        forbidden.filter((entry) => entry.code.includes('no-raw-project-catalog-computed'))
      ).toHaveLength(1)
    }
    const allowed = 'src/renderer/src/store/project-host-setup-selector.ts'
    expect(lint(allowed)).toEqual([])
    const uuid = lint(allowed, 'crypto.randomUUID()')
    expect(uuid).toHaveLength(1)
    expect(uuid[0].message).toContain('randomUUID')
    for (const file of [
      'src/main/native-chat/agent-session-wire/structured-agent-session-host-test-harness.ts',
      'src/main/runtime/rpc/methods/structured-chat-tab-table.test-fixture.ts',
      'mobile/src/test-support/rpc-recording/native-mounting-substitutes.test.ts',
      'tests/e2e/worktree-smart-sort.spec.ts'
    ]) {
      expect(lint(file, 'crypto.randomUUID()')).toEqual([])
    }
    const sharedUuid = lint('src/shared/tmux-status.test-fixture.ts', 'crypto.randomUUID()')
    expect(sharedUuid).toHaveLength(1)
    expect(sharedUuid[0].help).toContain('src/shared is compiled into the web bundle')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
