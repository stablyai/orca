import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nativeRoute = readFileSync(
  new URL('../../app/h/[hostId]/files/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const hostedRoute = readFileSync(
  new URL('../../host-web-app/h/[hostId]/files/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const presentation = readFileSync(new URL('./MobileFileExplorerPanel.tsx', import.meta.url), 'utf8')

describe('mobile web file explorer screen binding', () => {
  it('mounts the existing file explorer with strict injected operations', () => {
    expect(nativeRoute).toContain('export function MobileFileExplorerScreen(')
    expect(presentation).toContain('defaultHostFileExplorerOperations(')
    expect(presentation).not.toContain("sendRequest('files.readDir'")
    expect(presentation).not.toContain("sendRequest('files.list'")
    expect(hostedRoute).toContain(
      "import { MobileFileExplorerScreen } from '../../../../app/h/[hostId]/files/[worktreeId]'"
    )
    expect(hostedRoute).toContain('webHostFileExplorerOperations(shell.client)')
    expect(hostedRoute).toContain('operations={operations}')
    expect(hostedRoute).toContain('nativeHostBinding={false}')
    expect(hostedRoute).not.toMatch(/StyleSheet|className|<View|<Text|<Pressable|<div/)
  })
})
