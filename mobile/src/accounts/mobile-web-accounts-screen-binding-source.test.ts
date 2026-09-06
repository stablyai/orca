import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nativeRoute = readFileSync(
  new URL('../../app/h/[hostId]/accounts.tsx', import.meta.url),
  'utf8'
)
const hostedRoute = readFileSync(
  new URL('../../host-web-app/h/[hostId]/accounts.tsx', import.meta.url),
  'utf8'
)

describe('mobile web accounts screen binding', () => {
  it('mounts the existing mobile screen with injected bridge operations', () => {
    expect(nativeRoute).toContain('export function AccountsScreen(')
    expect(nativeRoute).toContain('defaultHostAccountsOperations(')
    expect(nativeRoute).not.toContain("client.sendRequest('accounts.list')")
    expect(nativeRoute).not.toContain("client.subscribe('accounts.subscribe'")
    expect(hostedRoute).toContain(
      "import { AccountsScreen } from '../../../app/h/[hostId]/accounts'"
    )
    expect(hostedRoute).toContain(
      "webHostAccountsOperations(shell.client, shell.hostDisplayName ?? 'Orca Desktop')"
    )
    expect(hostedRoute).toContain('operations={operations}')
    expect(hostedRoute).toContain('nativeHostBinding={false}')
    expect(hostedRoute).not.toMatch(/StyleSheet|className|<View|<Text|<Pressable|<div/)
  })
})
