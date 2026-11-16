import { ZOTZ_TAILNET_RANGE } from '../../shared/zotz/zotz-node-setup-contract'
import { renderZotzDesktopAutostart, ZOTZ_SERVER_SYSTEMD_UNIT } from './zotz-desktop-autostart'
import type { ZotzNodeSetupEnvironment } from './zotz-node-setup-environment'
import type { ZotzNodeSetupPhase } from './zotz-node-setup-orchestrator'
import { processOutput } from './zotz-process-runner'

/** `pmset -g custom` prints one block per power source; only the AC block matters for a node. */
export function readPmsetAcSettings(output: string): Map<string, string> {
  const settings = new Map<string, string>()
  let inAc = false
  for (const line of output.split('\n')) {
    if (/^\S/.test(line)) {
      inAc = /^AC Power/i.test(line)
      continue
    }
    const match = inAc ? /^\s+(\S+)\s+(\S+)/.exec(line) : null
    if (match) {
      settings.set(match[1]!, match[2]!)
    }
  }
  return settings
}

export function macPowerPhase(environment: ZotzNodeSetupEnvironment): ZotzNodeSetupPhase {
  return {
    steps: ['power'],
    run: async () => {
      const current = readPmsetAcSettings(
        (await environment.run('/usr/bin/pmset', ['-g', 'custom'])).stdout
      )
      if (current.get('sleep') === '0') {
        return { power: { status: 'done', detail: 'already set: AC sleep never' } }
      }
      // autorestart/womp are unsupported on some Macs; never let them fail the sleep change.
      const shell =
        '/usr/bin/pmset -c sleep 0 disksleep 0 && (/usr/bin/pmset -c womp 1 autorestart 1 || true)'
      const result = await environment.run(
        '/usr/bin/osascript',
        ['-e', `do shell script "${shell}" with administrator privileges`],
        5 * 60_000
      )
      if (result.code === 0) {
        return { power: { status: 'done', detail: 'AC: sleep never, restart after power loss' } }
      }
      const output = processOutput(result)
      return {
        power: {
          status: 'failed',
          detail: /-128/.test(output) ? 'administrator permission was declined' : output
        }
      }
    }
  }
}

export function macFirewallPhase(): ZotzNodeSetupPhase {
  return {
    steps: ['firewall'],
    run: async () => ({ firewall: { status: 'skipped', detail: 'not needed on macOS' } })
  }
}

export function linuxFirewallPhase(environment: ZotzNodeSetupEnvironment): ZotzNodeSetupPhase {
  return {
    steps: ['firewall'],
    run: async () => {
      const active = await environment.run('systemctl', ['is-active', 'ufw'])
      if (active.stdout.trim() !== 'active') {
        return { firewall: { status: 'skipped', detail: 'ufw is not active' } }
      }
      // ufw skips a rule it already has, so re-running adds nothing.
      const result = await environment.run(
        '/usr/bin/pkexec',
        [
          'ufw',
          'allow',
          'proto',
          'tcp',
          'from',
          ZOTZ_TAILNET_RANGE,
          'to',
          'any',
          'port',
          String(environment.port),
          'comment',
          'Zotz (Tailscale)'
        ],
        5 * 60_000
      )
      if (result.code === 0) {
        return {
          firewall: { status: 'done', detail: `TCP ${environment.port} from ${ZOTZ_TAILNET_RANGE}` }
        }
      }
      // pkexec: 126 = dialog dismissed, 127 = not authorized.
      return {
        firewall: {
          status: 'failed',
          detail:
            result.code === 126 || result.code === 127
              ? 'administrator permission was declined'
              : processOutput(result)
        }
      }
    }
  }
}

export function posixAutostartPhase(environment: ZotzNodeSetupEnvironment): ZotzNodeSetupPhase {
  return {
    steps: ['autostart'],
    run: async () => {
      if (!environment.isPackaged) {
        return { autostart: { status: 'skipped', detail: 'development build' } }
      }
      const spec = renderZotzDesktopAutostart({
        platform: environment.platform,
        // An AppImage's execPath lives in a mount that disappears when it exits.
        executablePath: environment.env.APPIMAGE ?? environment.executablePath,
        homeDir: environment.homeDir,
        userDataPath: environment.userDataPath,
        windowsUserId: environment.username
      })
      if (!spec) {
        return {
          autostart: { status: 'skipped', detail: `unsupported on ${environment.platform}` }
        }
      }
      environment.writeFile(spec.path, spec.content)
      // Loading now would start a second instance; the agent/unit takes over from the next login.
      if (environment.platform === 'linux') {
        const reload = await environment.run('systemctl', ['--user', 'daemon-reload'])
        const enable = await environment.run('systemctl', [
          '--user',
          'enable',
          ZOTZ_SERVER_SYSTEMD_UNIT
        ])
        if (reload.code !== 0 || enable.code !== 0) {
          return {
            autostart: {
              status: 'failed',
              detail: processOutput(enable.code !== 0 ? enable : reload)
            }
          }
        }
      }
      return { autostart: { status: 'done', detail: spec.path } }
    }
  }
}
