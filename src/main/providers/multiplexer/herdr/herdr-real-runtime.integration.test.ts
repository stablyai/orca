import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { configHomeDir } from './herdr-test-config-home'
import { afterAll, describe, expect, it } from 'vitest'
import { HerdrCliHostTransport, localHerdrCommand } from './herdr-cli-host-transport'
import type { HerdrSessionSnapshot } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import { resolveStockHerdrTestBinary } from './herdr-stock-binary'

const binary = resolveStockHerdrTestBinary()
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

  it('echoes input through pane.send_text and pane.read', async () => {
    await transport.ensureSession(sessionName)
    const created = unwrapHerdrResponse<{
      root_pane: { pane_id: string }
    }>(
      await transport.request(sessionName, 'workspace.create', {
        cwd: configHome,
        label: 'Orca io',
        focus: false
      })
    )
    const marker = `STOCK_IO_${process.pid}`
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_text', {
        pane_id: created.root_pane.pane_id,
        text: `echo ${marker}`
      })
    )
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_keys', {
        pane_id: created.root_pane.pane_id,
        keys: ['Enter']
      })
    )

    const deadline = Date.now() + 10_000
    let text = ''
    while (Date.now() < deadline) {
      const read = unwrapHerdrResponse<{ read: { text: string } }>(
        await transport.request(sessionName, 'pane.read', {
          pane_id: created.root_pane.pane_id,
          source: 'recent',
          lines: 80
        })
      )
      text = read.read.text
      if (text.includes(marker)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(text).toContain(marker)
  }, 30_000)
})
