/**
 * The way out of the protocol-block screen, which inside the page must not be expo-router's.
 *
 * This screen is in the tasks page closure and already renders on the live `/h/[hostId]` page. Its
 * "Back to hosts" targets `/`, the phone's home screen, which the page does not carry: taken on
 * the singleton it renders the root route inside the shell's WebView instead of leaving it. The
 * handoff posts that target to the shell, which opens the native screen over the still-mounted
 * page.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCREEN = join(import.meta.dirname, 'ProtocolBlockScreen.tsx')

describe('the protocol-block screen leaving for the host list', () => {
  it('does not reach expo-router directly, whose router is the app singleton', () => {
    // A singleton import is the one shape the handoff cannot intercept: it is not a hook, so the
    // page's own bridge client is never consulted and the target never reaches the shell.
    expect(readFileSync(SCREEN, 'utf8')).not.toMatch(/from 'expo-router'/)
  })

  it('reaches the navigation handoff instead', () => {
    expect(readFileSync(SCREEN, 'utf8')).toContain("from '../navigation/route-handoff'")
  })
})
