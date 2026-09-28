/**
 * Every external link the tasks tree opens goes through the platform seam.
 *
 * The tree reaches `Linking` through one barrel, so the swap is one export rather than nine call
 * sites. Asserted on the source because importing the barrel pulls react-native's Flow entry into
 * the test environment; what matters here is which module the name comes from, which is a fact
 * about the text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BARREL = join(import.meta.dirname, 'mobile-tasks-dependencies.ts')

function reExportBlock(source: string, from: string): string {
  const pattern = new RegExp(String.raw`export \{([^}]*)\} from '${from}'`, 's')
  return pattern.exec(source)?.[1] ?? ''
}

describe('the Linking the tasks tree uses', () => {
  it('does not come from react-native, whose web build opens nothing inside the shell', () => {
    // react-native-web's `Linking.openURL` calls `window.open`, and both shells refuse it: iOS
    // returns nil from `createWebViewWith`, Android false from `onCreateWindow`. It resolves
    // anyway, so the native path would report success into a tap that did nothing.
    const source = readFileSync(BARREL, 'utf8')
    expect(reExportBlock(source, 'react-native')).not.toContain('Linking')
  })

  it('comes from the platform seam, so the page hands the URL to the shell', () => {
    expect(readFileSync(BARREL, 'utf8')).toContain("from '../platform/external-link'")
  })
})

/**
 * The tasks header's Back, which inside the page had nowhere to go.
 *
 * The document holds the one history entry the entry wrote with `replaceState`, so expo-router's
 * `back()` moves nothing; the stack that has somewhere to go is the native one the shell pushed
 * the page onto. `useRouteHandoff` is what posts `navigate-back` for it, and the tree reaches the
 * router through the same barrel it reached `Linking` through.
 */
describe('the router the tasks tree uses', () => {
  it('does not come from expo-router, whose back() moves nothing inside the page', () => {
    const source = readFileSync(BARREL, 'utf8')
    expect(reExportBlock(source, 'expo-router')).not.toContain('useRouter')
  })

  it('comes from the navigation handoff, which hands Back to the shell', () => {
    expect(readFileSync(BARREL, 'utf8')).toContain("from '../navigation/route-handoff'")
  })
})
