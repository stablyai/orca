import type { ChildProcess } from 'node:child_process'
import {
  getEphemeralVmRecipeResultConnection,
  parseEphemeralVmRecipeResult
} from '../../shared/ephemeral-vm-recipes'
import { GrowingByteBuffer } from '../../shared/growing-byte-buffer'
import { RuntimeClientError } from './types'

const IGNORED_NON_RECIPE_STDOUT = '[serve] ignored non-recipe stdout'
const MAX_RECIPE_OUTPUT_LINE_BYTES = 4 * 1024 * 1024

export function waitForRecipeJson(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const output = new GrowingByteBuffer()
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
      output.clear()
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
      // Why: non-readiness child stdout can contain arbitrary user data.
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
    const oversizedLineError = (): RuntimeClientError =>
      new RuntimeClientError(
        'runtime_serve_failed',
        `Recipe JSON output exceeded ${MAX_RECIPE_OUTPUT_LINE_BYTES} byte line limit.`
      )
    const onData = (chunk: Buffer | string): void => {
      if (settled) {
        return
      }
      output.append(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      while (!settled) {
        const newlineIndex = output.indexOfByte(0x0a)
        if (newlineIndex === -1) {
          break
        }
        if (newlineIndex > MAX_RECIPE_OUTPUT_LINE_BYTES) {
          finish(oversizedLineError())
          child.kill('SIGTERM')
          return
        }
        const line = output.takePrefixString(newlineIndex)
        output.discardPrefix(1)
        processRecipeOutputLine(line)
      }
      if (!settled && output.byteLength > MAX_RECIPE_OUTPUT_LINE_BYTES) {
        finish(oversizedLineError())
        child.kill('SIGTERM')
      }
    }
    const onError = (error: Error): void => {
      finish(error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      if (output.byteLength > MAX_RECIPE_OUTPUT_LINE_BYTES) {
        finish(oversizedLineError())
        return
      }
      const finalOutput = output.takeString()
      if (finalOutput.trim()) {
        processRecipeOutputLine(finalOutput)
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
    // Why: `close` waits for final piped stdout data that can arrive after `exit`.
    child.once('close', onClose)
  })
}
