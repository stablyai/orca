import { spawn } from 'node:child_process'
import {
  HerdrEventSubscriptionBuffer,
  herdrEventsSubscribeRequest
} from './herdr-event-subscription'
import type { HerdrCommand } from './herdr-command'

export function createHerdrCliEventSubscription(
  commandFor: (herdrArgs: string[]) => HerdrCommand,
  sessionName: string,
  afterSequence: number
): HerdrEventSubscriptionBuffer {
  const command = commandFor(['--session', sessionName, 'api', 'bridge'])
  const child = spawn(command.file, command.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(command.env ? { env: command.env } : {})
  })
  const subscription = new HerdrEventSubscriptionBuffer(() => {
    child.stdin.end()
    child.kill()
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline === -1) {
        break
      }
      const line = stdout.slice(0, newline).trim()
      stdout = stdout.slice(newline + 1)
      if (!line) {
        continue
      }
      try {
        subscription.acceptLine(line)
      } catch (error) {
        subscription.fail(error)
      }
    }
  })
  child.stderr.on('data', (chunk: string) => (stderr += chunk))
  child.once('error', (error) => subscription.fail(error))
  child.once('close', (code) => {
    if (code !== 0) {
      subscription.fail(
        new Error(stderr.trim() || `Herdr event subscription exited with code ${code ?? 'unknown'}`)
      )
    }
  })
  child.stdin.write(herdrEventsSubscribeRequest(afterSequence))
  return subscription
}
