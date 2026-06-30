import { spawn } from 'child_process'
import { connect } from 'net'
import { setTimeout as delay } from 'timers/promises'
import { quoteCliCommandArgument } from '../shell-command-quote'
import { RuntimeClientError } from './types'

type ContainerNetworkInfo = {
  networkName: string
  containerIp: string
}

export function spawnBridgeContainer(args: {
  bridgeName: string
  networkName: string
  containerIp: string
  hostPort: number
  containerPort: number
}): ReturnType<typeof spawn> {
  // Why: the bridge container must join the devcontainer's Docker network so
  // the published host port can still reach the container IP that serves Orca.
  return spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      args.bridgeName,
      '--network',
      args.networkName,
      '-p',
      `127.0.0.1:${args.hostPort}:${args.hostPort}`,
      'alpine',
      'sh',
      '-lc',
      `apk add --no-cache socat >/dev/null 2>&1 && exec socat -d -d TCP-LISTEN:${args.hostPort},fork,reuseaddr TCP:${args.containerIp}:${args.containerPort}`
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
}

export function spawnDevcontainerServe(args: {
  container: string
  containerPort: number
  hostPort: number
  orcaBin: string
}): ReturnType<typeof spawn> {
  return spawn(
    'docker',
    [
      'exec',
      args.container,
      'sh',
      '-lc',
      `${quoteCliCommandArgument(args.orcaBin)} serve --json --port ${args.containerPort} --pairing-address 127.0.0.1:${args.hostPort}`
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

export function waitForBridgeReady(
  child: ReturnType<typeof spawn>,
  bridgeName: string,
  hostPort: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000
    let stderr = ''
    let settled = false
    const cleanup = (): void => {
      child.stderr?.off('data', onStderrData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const settleResolve = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }
    const settleReject = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const onStderrData = (chunk: Buffer | string): void => {
      stderr += chunk.toString()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settleReject(createBridgeStartupError(bridgeName, stderr, code, signal))
    }
    const onError = (error: Error): void => {
      settleReject(error)
    }

    child.stderr?.on('data', onStderrData)
    child.once('exit', onExit)
    child.once('error', onError)

    void (async () => {
      while (!settled) {
        if (Date.now() > deadline) {
          settleReject(
            new RuntimeClientError(
              'runtime_error',
              `Docker bridge ${bridgeName} did not become reachable on 127.0.0.1:${hostPort} within 30 seconds.`
            )
          )
          return
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          settleReject(
            createBridgeStartupError(bridgeName, stderr, child.exitCode, child.signalCode)
          )
          return
        }
        if (await canConnectToHostPort(hostPort)) {
          await delay(100)
          if (child.exitCode !== null || child.signalCode !== null) {
            settleReject(
              createBridgeStartupError(bridgeName, stderr, child.exitCode, child.signalCode)
            )
            return
          }
          settleResolve()
          return
        }
        await delay(50)
      }
    })().catch(settleReject)
  })
}

export function readContainerNetworkAndIp(container: string): Promise<ContainerNetworkInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'inspect',
        '-f',
        '{{range $name, $network := .NetworkSettings.Networks}}{{$name}}\t{{$network.IPAddress}}{{"\n"}}{{end}}',
        container
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''

    const onStdoutData = (chunk: Buffer | string): void => {
      stdout += chunk.toString()
    }
    const onStderrData = (chunk: Buffer | string): void => {
      stderr += chunk.toString()
    }
    const onExit = (code: number | null): void => {
      cleanup()
      if (code !== 0) {
        reject(
          new RuntimeClientError(
            'runtime_error',
            stderr.trim().length > 0
              ? stderr.trim()
              : `Could not inspect Docker container ${container}.`
          )
        )
        return
      }
      const line = stdout
        .trim()
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find((value) => value.length > 0)
      if (!line) {
        reject(
          new RuntimeClientError(
            'runtime_error',
            `Could not read a Docker network for ${container}.`
          )
        )
        return
      }
      const [networkName, containerIp] = line.split('\t')
      if (!networkName || !containerIp) {
        reject(
          new RuntimeClientError(
            'runtime_error',
            `Could not parse Docker network data for ${container}.`
          )
        )
        return
      }
      resolve({ networkName, containerIp })
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const cleanup = (): void => {
      child.stdout?.off('data', onStdoutData)
      child.stderr?.off('data', onStderrData)
      child.off('exit', onExit)
      child.off('error', onError)
    }

    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

export function stopServeContainer(child: ReturnType<typeof spawn> | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  child.kill('SIGTERM')
}

export function stopBridgeContainer(child: ReturnType<typeof spawn> | null): void {
  if (!child) {
    return
  }
  child.kill('SIGTERM')
}

function canConnectToHostPort(hostPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: hostPort })
    let settled = false
    const finish = (ready: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(ready)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function createBridgeStartupError(
  bridgeName: string,
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null
): RuntimeClientError {
  const trimmedStderr = stderr.trim()
  return new RuntimeClientError(
    'runtime_error',
    trimmedStderr.length > 0
      ? trimmedStderr
      : `Docker bridge ${bridgeName} exited before readiness${code !== null ? ` with code ${code}` : ''}${signal ? ` via ${signal}` : ''}.`
  )
}
