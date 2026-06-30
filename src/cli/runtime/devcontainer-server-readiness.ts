import type { spawn } from 'child_process'
import { RuntimeClientError } from './types'

export type DevcontainerServerReady = {
  type: 'orca_server_ready'
  runtimeId: string
  pairing: { url: string }
}

export function waitForOrcaServerReady(
  child: ReturnType<typeof spawn>
): Promise<DevcontainerServerReady> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const cleanup = (): void => {
      child.stdout?.off('data', onStdoutData)
      child.stderr?.off('data', onStderrData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onStdoutData = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      const ready = consumeReadyLine(buffer)
      buffer = ready.remaining
      if (ready.payload) {
        cleanup()
        resolve(ready.payload)
      }
    }
    const onStderrData = (chunk: Buffer | string): void => {
      process.stderr.write(chunk)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      if (code === 0) {
        reject(
          new RuntimeClientError(
            'runtime_error',
            'orca serve exited before printing the orca_server_ready JSON line.'
          )
        )
        return
      }
      reject(
        new RuntimeClientError(
          'runtime_error',
          `orca serve exited before readiness${code !== null ? ` with code ${code}` : ''}${signal ? ` via ${signal}` : ''}.`
        )
      )
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }

    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

export function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode === 0) {
      return Promise.resolve()
    }
    return Promise.reject(
      new RuntimeClientError(
        'runtime_error',
        `orca serve exited after readiness${child.exitCode !== null ? ` with code ${child.exitCode}` : ''}${child.signalCode ? ` via ${child.signalCode}` : ''}.`
      )
    )
  }
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new RuntimeClientError(
          'runtime_error',
          `orca serve exited after readiness${code !== null ? ` with code ${code}` : ''}${signal ? ` via ${signal}` : ''}.`
        )
      )
    }
    child.once('exit', onExit)
    child.once('error', reject)
  })
}

function consumeReadyLine(buffer: string): {
  payload: DevcontainerServerReady | null
  remaining: string
} {
  let remaining = buffer
  while (true) {
    const newlineIndex = remaining.indexOf('\n')
    if (newlineIndex === -1) {
      return { payload: null, remaining }
    }
    const line = remaining.slice(0, newlineIndex).trim()
    remaining = remaining.slice(newlineIndex + 1)
    const payload = parseReadyPayload(line)
    if (payload) {
      return { payload, remaining }
    }
  }
}

function parseReadyPayload(line: string): DevcontainerServerReady | null {
  if (line.trim().length === 0) {
    return null
  }
  try {
    const parsed = JSON.parse(line) as Partial<DevcontainerServerReady> & {
      pairing?: { url?: unknown } | null
    }
    if (
      parsed.type === 'orca_server_ready' &&
      typeof parsed.runtimeId === 'string' &&
      parsed.pairing != null &&
      typeof parsed.pairing.url === 'string' &&
      parsed.pairing.url.length > 0
    ) {
      return {
        type: 'orca_server_ready',
        runtimeId: parsed.runtimeId,
        pairing: { url: parsed.pairing.url }
      }
    }
    return null
  } catch {
    return null
  }
}
