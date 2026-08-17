import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { configHomeDir } from './herdr-test-config-home'
import { afterAll, describe, expect, it } from 'vitest'
import { HerdrCliHostTransport, localHerdrCommand } from './herdr-cli-host-transport'
import type { HerdrSessionSnapshot } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'

const binary = process.env.ORCA_HERDR_TEST_BINARY
const describeRealHerdr = binary ? describe : describe.skip

describeRealHerdr('stock Herdr runtime integration', () => {
  const configHome = configHomeDir()
  const sessionName = `ot-${process.pid}`
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: configHome }
  for (const name of Object.keys(env)) {
    if (name.startsWith('HERDR_')) {
      delete env[name]
    }
  }
  const transport = new HerdrCliHostTransport({
    commandFor: localHerdrCommand(binary as string, env),
    timeoutMs: 30_000
  })

  afterAll(() => {
    try {
      execFileSync(binary as string, ['session', 'stop', sessionName, '--json'], {
        env,
        stdio: 'ignore',
        timeout: 30_000
      })
    } catch {
      // Session never started (early failure); cleanup must not mask the original cause.
    } finally {
      rmSync(configHome, { recursive: true, force: true })
    }
  })

  it('starts a named server and reconciles through stock metadata commands', async () => {
    await transport.ensureSession(sessionName)
    const created = unwrapHerdrResponse<{
      workspace: { workspace_id: string }
      root_pane: { pane_id: string }
    }>(
      await transport.request(sessionName, 'workspace.create', {
        cwd: configHome,
        label: 'Orca integration',
        focus: false
      })
    )
    await transport.request(sessionName, 'workspace.report_metadata', {
      workspace_id: created.workspace.workspace_id,
      source: 'orca',
      tokens: { orca_binding: 'workspace-binding' }
    })
    await transport.request(sessionName, 'pane.report_metadata', {
      pane_id: created.root_pane.pane_id,
      source: 'orca',
      tokens: { orca_binding: 'pane-binding' }
    })

    const snapshot = unwrapHerdrResponse<{ snapshot: HerdrSessionSnapshot }>(
      await transport.request(sessionName, 'session.snapshot', {})
    ).snapshot
    expect(snapshot.protocol).toBe(19)
    expect(
      snapshot.workspaces.find(
        (workspace) => workspace.workspace_id === created.workspace.workspace_id
      )?.tokens
    ).toMatchObject({ orca_binding: 'workspace-binding' })
    expect(
      snapshot.panes.find((pane) => pane.pane_id === created.root_pane.pane_id)?.tokens
    ).toMatchObject({ orca_binding: 'pane-binding' })
  }, 30_000)
})
