import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SshAgentSignInFlow } from '../../../shared/ssh-agent-sign-in-types'
import { SSH_AGENT_LOGIN_COMMAND, SshAgentSignInFlows } from './ssh-agent-sign-in-flows'

class FakeChannel extends EventEmitter {
  write = vi.fn()
  close = vi.fn(() => this.emit('close', null))
  onOutput(listener: (chunk: string) => void): void {
    this.on('data', (chunk: Buffer | string) => listener(chunk.toString()))
  }
  onClose(listener: (code: number | null) => void): void {
    this.on('close', listener)
  }
  onError(listener: () => void): void {
    this.on('error', listener)
  }
}

function setup() {
  const channel = new FakeChannel()
  const exec = vi.fn(async (_command: string, _options?: { wrapCommand?: boolean }) => channel)
  const published: SshAgentSignInFlow[] = []
  const signedIn = vi.fn()
  const flows = new SshAgentSignInFlows(
    () => ({ exec }),
    (flow) => published.push(flow),
    signedIn
  )
  const last = () => published.at(-1)
  return { channel, exec, flows, last, signedIn }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

const CLAUDE_OUTPUT =
  "Browser didn't open? Use the url below to sign in:\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=x&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=s \n\nPaste code here if prompted > "

describe('SshAgentSignInFlows', () => {
  it('Claude: relays the claude.ai link, sends the pasted code on stdin only, settles signed in', async () => {
    const { channel, exec, flows, last, signedIn } = setup()
    const flow = flows.start('devbox', 'claude')
    await tick()
    expect(exec).toHaveBeenCalledWith(SSH_AGENT_LOGIN_COMMAND.claude, { wrapCommand: true })
    channel.emit('data', Buffer.from(CLAUDE_OUTPUT))
    expect(last()).toMatchObject({ phase: 'needsCode', url: expect.stringContaining('claude.ai') })
    expect(flows.submitCode(flow.flowId, '  abc123#state  ')).toBe(true)
    expect(channel.write).toHaveBeenCalledWith('abc123#state\n')
    // The code is never part of a command line.
    expect(JSON.stringify(exec.mock.calls)).not.toContain('abc123')
    expect(JSON.stringify(last())).not.toContain('abc123')
    channel.emit('close', 0)
    expect(last()?.phase).toBe('signedIn')
    expect(signedIn).toHaveBeenCalledWith('devbox')
  })

  it('refuses a code before the prompt, or one that isn’t a single token', async () => {
    const { channel, flows } = setup()
    const flow = flows.start('devbox', 'claude')
    await tick()
    expect(flows.submitCode(flow.flowId, 'early')).toBe(false)
    channel.emit('data', CLAUDE_OUTPUT)
    expect(flows.submitCode(flow.flowId, 'two words')).toBe(false)
    expect(channel.write).not.toHaveBeenCalled()
  })

  it('a rejected code fails as rejected; a missing CLI as not installed', async () => {
    const first = setup()
    const flow = first.flows.start('devbox', 'claude')
    await tick()
    first.channel.emit('data', CLAUDE_OUTPUT)
    first.flows.submitCode(flow.flowId, 'bad')
    first.channel.emit('close', 1)
    expect(first.last()).toMatchObject({ phase: 'failed', error: 'rejected' })
    const second = setup()
    second.flows.start('devbox', 'codex')
    await tick()
    second.channel.emit('close', 127)
    expect(second.last()).toMatchObject({ phase: 'failed', error: 'notInstalled' })
  })

  it('Codex: shows the device code and its auth.openai.com page', async () => {
    const { channel, flows, last } = setup()
    flows.start('devbox', 'codex')
    await tick()
    channel.emit(
      'data',
      'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   K7QX-M2PL\n\n'
    )
    expect(last()).toMatchObject({
      phase: 'device',
      userCode: 'K7QX-M2PL',
      url: 'https://auth.openai.com/codex/device'
    })
  })

  it('cancel closes the remote command; one flow per host and agent', async () => {
    const { channel, flows, last } = setup()
    const flow = flows.start('devbox', 'claude')
    expect(flows.start('devbox', 'claude').flowId).toBe(flow.flowId)
    await tick()
    flows.cancel(flow.flowId)
    expect(channel.close).toHaveBeenCalled()
    expect(last()?.phase).toBe('cancelled')
  })
})
