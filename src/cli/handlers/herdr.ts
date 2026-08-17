import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { HerdrRuntimeError } from '../../main/providers/multiplexer/herdr/herdr-runtime-contract'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'
import { HerdrTransport } from '../../main/providers/multiplexer/herdr/herdr-transport'

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: {
      runtimeId: 'local'
    }
  }
}

async function withClient<T>(
  socketPath: string | undefined,
  fn: (transport: HerdrTransport) => Promise<T>
): Promise<T> {
  const transport = new HerdrTransport(socketPath)
  try {
    await transport.connect()
    return await fn(transport)
  } finally {
    await transport.close()
  }
}

export const HERDR_HANDLERS: Record<string, CommandHandler> = {
  'herdr daemon': async ({ flags, json }) => {
    const socketPath = flags.get('socket') as string | undefined
    const foreground = flags.get('foreground') === true

    const transport = new HerdrTransport(socketPath)

    try {
      if (foreground) {
        await transport.startServer()
        console.error(
          '[herdr-daemon] Daemon started in foreground, listening on',
          socketPath ?? transport['socketPath']
        )

        await new Promise<void>((resolve) => {
          process.on('SIGINT', () => resolve())
          process.on('SIGTERM', () => resolve())
        })

        await transport.close()
      } else {
        try {
          await transport.connect()
          await transport.close()
          printResult(
            localSuccess({ status: 'already_running', message: 'herdr daemon is already running' }),
            json,
            (v: { message: string }) => v.message
          )
        } catch {
          printResult(
            localSuccess({ status: 'not_running', message: 'herdr daemon is not running' }),
            json,
            (v: { message: string }) => v.message
          )
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      printResult(
        localSuccess({ status: 'error', message }),
        json,
        (v: { message: string }) => v.message
      )
      process.exitCode = 1
    }
  },

  'herdr session list': async ({ json }) => {
    try {
      const result = await withClient(undefined, async (transport) => {
        return transport.request('session.list', {})
      })

      printResult(localSuccess(result), json, (v) => JSON.stringify(v, null, 2))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      printResult(
        localSuccess({ status: 'error', message }),
        json,
        (v: { message: string }) => v.message
      )
      process.exitCode = 1
    }
  },

  'herdr pane create': async ({ flags, json }) => {
    try {
      const project = flags.get('project') as string
      const workspace = flags.get('workspace') as string
      const tab = flags.get('tab') as string
      const leaf = flags.get('leaf') as string
      const cols = Number(flags.get('cols'))
      const rows = Number(flags.get('rows'))
      const cwd = flags.get('cwd') as string | undefined
      const command = flags.get('command') as string | undefined

      if (!project || !workspace || !tab || !leaf || Number.isNaN(cols) || Number.isNaN(rows)) {
        throw new HerdrRuntimeError(
          'invalid_args',
          'Missing required flags: project, workspace, tab, leaf, cols, rows'
        )
      }

      const result = await withClient(undefined, async (transport) => {
        return transport.request('pane.create', {
          target: { project, workspace, tab, leaf },
          options: { cols, rows, cwd, command }
        })
      })

      printResult(localSuccess(result), json, (v: unknown) => JSON.stringify(v, null, 2))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      printResult(
        localSuccess({ status: 'error', message }),
        json,
        (v: { message: string }) => v.message
      )
      process.exitCode = 1
    }
  },

  'herdr pane split': async ({ flags, json }) => {
    try {
      const paneId = flags.get('pane') as string
      const direction = flags.get('direction') as 'right' | 'down'
      const ratio = flags.get('ratio') !== undefined ? Number(flags.get('ratio')) : undefined

      if (!paneId || !direction) {
        throw new HerdrRuntimeError('invalid_args', 'Missing required flags: pane, direction')
      }

      const result = await withClient(undefined, async (transport) => {
        return transport.request('pane.split', { pane_id: paneId, direction, ratio })
      })

      printResult(localSuccess(result), json, (v: unknown) => JSON.stringify(v, null, 2))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      printResult(
        localSuccess({ status: 'error', message }),
        json,
        (v: { message: string }) => v.message
      )
      process.exitCode = 1
    }
  },

  'herdr pane resize': async ({ flags, json }) => {
    try {
      const paneId = flags.get('pane') as string
      const cols = Number(flags.get('cols'))
      const rows = Number(flags.get('rows'))

      if (!paneId || Number.isNaN(cols) || Number.isNaN(rows)) {
        throw new HerdrRuntimeError('invalid_args', 'Missing required flags: pane, cols, rows')
      }

      await withClient(undefined, async (transport) => {
        await transport.request('pane.resize', { pane_id: paneId, cols, rows })
      })

      printResult(localSuccess({ status: 'ok' }), json, (v: { status: string }) => v.status)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      printResult(
        localSuccess({ status: 'error', message }),
        json,
        (v: { message: string }) => v.message
      )
      process.exitCode = 1
    }
  },

  'herdr pane close': async ({ flags, json }) => {
    try {
      const paneId = flags.get('pane') as string

      if (!paneId) {
        throw new HerdrRuntimeError('invalid_args', 'Missing required flag: pane')
      }

      await withClient(undefined, async (transport) => {
        await transport.request('pane.close', { pane_id: paneId })
      })

      printResult(localSuccess({ status: 'ok' }), json, (v: { status: string }) => v.status)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      printResult(
        localSuccess({ status: 'error', message }),
        json,
        (v: { message: string }) => v.message
      )
      process.exitCode = 1
    }
  },

  'herdr pane send-keys': async ({ flags, json }) => {
    try {
      const paneId = flags.get('pane') as string
      const keys = (flags.get('keys') as string | undefined)?.split(',') ?? []

      if (!paneId || !keys.length) {
        throw new HerdrRuntimeError('invalid_args', 'Missing required flags: pane, keys')
      }

      await withClient(undefined, async (transport) => {
        await transport.request('pane.send_keys', { pane_id: paneId, keys })
      })

      printResult(localSuccess({ status: 'ok' }), json, (v: { status: string }) => v.status)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      printResult(
        localSuccess({ status: 'error', message }),
        json,
        (v: { message: string }) => v.message
      )
      process.exitCode = 1
    }
  }
}
