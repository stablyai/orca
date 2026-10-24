import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { StringDecoder } from 'node:string_decoder'
import {
  getEphemeralVmRecipeResultConnection,
  parseEphemeralVmRecipeResult
} from '../../shared/ephemeral-vm-recipes'
import { RuntimeClientError } from './types'

const IGNORED_NON_RECIPE_STDOUT = '[serve] ignored non-recipe stdout'

export function waitForRecipeJson(child: ChildProcessHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timeout = setTimeout(() => {
      finish(new RuntimeClientError('runtime_serve_failed', 'Timed out waiting for recipe JSON.'))
      child.kill('SIGTERM')
    }, 60000)
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      child.stdout?.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
      if (error) {
        reject(error)
        return
      }
      child.stdout?.destroy?.()
      child.unref()
      resolve(0)
    }
    const writeIgnoredRecipeStdout = (): void => {
      // Arbitrary child output cannot be reliably redacted, even when it matches the schema.
      process.stderr.write(`${IGNORED_NON_RECIPE_STDOUT}\n`)
    }
    const processRecipeOutputLine = (line: string): void => {
      const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
      if (!normalizedLine.trim()) {
        return
      }
      const parsed = parseEphemeralVmRecipeResult(normalizedLine)
      if (!parsed.ok) {
        writeIgnoredRecipeStdout()
        return
      }
      if (getEphemeralVmRecipeResultConnection(parsed.result).type !== 'orca-server') {
        writeIgnoredRecipeStdout()
        return
      }
      process.stdout.write(`${normalizedLine.trim()}\n`)
      finish()
    }
    const stdoutDecoder = new StringDecoder('utf8')
    const onData = (chunk: Buffer | string): void => {
      output += typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk)
      while (!settled) {
        const newlineIndex = output.indexOf('\n')
        if (newlineIndex === -1) {
          return
        }
        const line = output.slice(0, newlineIndex)
        output = output.slice(newlineIndex + 1)
        processRecipeOutputLine(line)
      }
    }
    const onError = (error: Error): void => {
      finish(error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      output += stdoutDecoder.end()
      if (output.trim()) {
        processRecipeOutputLine(output)
      }
      if (settled) {
        return
      }
      finish(
        new RuntimeClientError(
          'runtime_serve_failed',
          typeof code === 'number'
            ? `Orca serve exited before printing valid recipe JSON with code ${code}.`
            : `Orca serve exited before printing valid recipe JSON via ${signal}.`
        )
      )
    }
    child.stdout?.on('data', onData)
    child.once('error', onError)
    // Wait for close: exit may precede the final recipe data on stdout.
    child.once('close', onClose)
  })
}
