import { expect, it } from 'vitest'
import { agentBrowserCookieSetArguments } from './agent-browser-cookie-set-arguments'
import { agentBrowserWaitArguments } from './agent-browser-wait-arguments'

it('builds cookie arguments with caller values as operands', () => {
  expect(
    agentBrowserCookieSetArguments({
      name: 'sid',
      value: '-1',
      domain: 'example.com',
      secure: true
    })
  ).toEqual(['cookies', 'set', 'sid', '-1', '--domain', 'example.com', '--secure'])
})

it.each([
  () => agentBrowserCookieSetArguments({ name: '--curl', value: '/tmp/.env' }),
  () => agentBrowserCookieSetArguments({ name: 'sid', value: '--curl=/tmp/.env' }),
  () => agentBrowserCookieSetArguments({ name: ['--curl'], value: '/tmp/.env' }),
  () => agentBrowserWaitArguments({ selector: '--download=/tmp/out' })
])('refuses operands agent-browser would read as file options', (build) => {
  expect(build).toThrow('agent-browser would read it as an option')
})
