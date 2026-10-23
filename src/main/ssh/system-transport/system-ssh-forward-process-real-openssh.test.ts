/**
 * Real OpenSSH: a forward process must own its listener and see sshd's refusals even when the
 * user's ssh_config multiplexes through a ControlMaster. Opt-in (needs sshd and ssh on PATH):
 * ORCA_REAL_OPENSSH_TEST=1 pnpm test src/main/ssh/system-transport/system-ssh-forward-process-real-openssh.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SshConnection } from '../connection/ssh-connection'
import { SystemSshPortForwardProvider } from '../port-forwarding/system-ssh-port-forward-provider'
import { checkForwardChannel } from '../ssh-tcp-forwarding-probe'
import {
  REAL_OPENSSH_TEST_ENABLED,
  dial,
  freePort,
  startRealOpenSshFixture,
  type RealOpenSshFixture
} from './real-openssh-sshd-fixture'
import { startSystemSshPortForwardProcess } from './system-ssh-forward-process'

describe.skipIf(!REAL_OPENSSH_TEST_ENABLED)(
  'system SSH forward process under a user ControlMaster (real OpenSSH)',
  () => {
    let fixture: RealOpenSshFixture
    // A port sshd's PermitOpen does not allow, so opening a channel to it is administratively refused.
    let prohibitedPort = 0
    const buildOptions = () => ({ ...fixture.buildOptions(), logChannelFailures: true })

    beforeAll(async () => {
      prohibitedPort = await freePort()
      fixture = await startRealOpenSshFixture({ sshd: ['PermitOpen 127.0.0.1:1'] })
    }, 30_000)

    afterAll(async () => {
      await fixture?.close()
    })

    it('closing the forward releases its listener', async () => {
      const forward = await startSystemSshPortForwardProcess(
        fixture.target,
        0,
        '127.0.0.1',
        prohibitedPort,
        buildOptions()
      )
      await forward.waitForStartup()
      expect(await dial(forward.localPort)).toBe(true)
      await forward.close()
      expect(await dial(forward.localPort)).toBe(false)
    }, 20_000)

    // Why: any fixed-port forward starts here, and a master's forward may be the user's own; only
    // the managed tunnel asks a master to give its persisted port back.
    it("never takes a fixed port from a master's forward", async () => {
      const heldPort = await freePort()
      const spec = `127.0.0.1:${heldPort}:127.0.0.1:${prohibitedPort}`
      fixture.ssh(['-O', 'forward', '-L', spec])
      try {
        await expect(
          startSystemSshPortForwardProcess(
            fixture.target,
            heldPort,
            '127.0.0.1',
            prohibitedPort,
            buildOptions()
          )
        ).rejects.toThrow(/is not available/)
        expect(await dial(heldPort)).toBe(true)
      } finally {
        fixture.ssh(['-O', 'cancel', '-L', spec])
      }
    }, 20_000)

    it("sees sshd's administrative refusal on its own stderr", async () => {
      const conn = {
        getTarget: () => fixture.target,
        getSystemSshBuildArgsOptions: buildOptions
      } satisfies Pick<SshConnection, 'getTarget' | 'getSystemSshBuildArgsOptions'>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the system SSH provider's start reads only getTarget and getSystemSshBuildArgsOptions.
      const connection = conn as unknown as SshConnection
      const started = await new SystemSshPortForwardProvider().start(connection, {
        id: 'pf-real',
        connectionId: fixture.target.id,
        localHost: '127.0.0.1',
        localPort: 0,
        remoteHost: '127.0.0.1',
        remotePort: prohibitedPort
      })
      try {
        expect(await checkForwardChannel(started)).toBe('refused')
      } finally {
        await started.close()
      }
    }, 20_000)
  }
)
