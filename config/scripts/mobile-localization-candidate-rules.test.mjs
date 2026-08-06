import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  collectLocalizationCandidates,
  main as auditLocalizationCoverage
} from './audit-localization-coverage.mjs'

describe('mobile-localization-candidate-rules', () => {
  it('finds grammatical fragments returned by repositoryCount', () => {
    const source = `
function repositoryCount(count) {
  return \`\${count} \${count === 1 ? 'repository' : 'repositories'}\`
}
`
    const candidates = collectLocalizationCandidates('/repo/mobile/app/tasks.tsx', source, '/repo')

    expect(candidates.map((candidate) => candidate.text)).toEqual(['repository', 'repositories'])
  })

  it('finds copy embedded in mobile WebView documents', () => {
    const source = String.raw`
export const HTML = \`<!doctype html>
<main data-placeholder="Start writing..."></main>
<button>Copy</button><button>Select All</button>
<script>
  window.prompt('Link URL');
  document.execCommand('insertHTML', false, '<p>Task ' + localized + '</p><p>Follow up</p>');
</script>
\`
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/example-html.ts',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'Start writing...',
      'Copy',
      'Select All',
      'Link URL',
      'Task',
      'Follow up'
    ])
  })

  it('finds static copy around dynamic WebView values and prompts', () => {
    const source = [
      'export const HTML = `<!doctype html>',
      '<button title="Copy ${name}">Retry ${name}</button>',
      '<script>window.alert(\\`Could not load ${name}\\`);</script>',
      '`'
    ].join('\n')
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/example-webview-html.ts',
      source,
      '/repo'
    )

    expect(candidates.map(({ dynamic, text }) => ({ dynamic, text }))).toEqual([
      { dynamic: true, text: 'Copy' },
      { dynamic: true, text: 'Retry' },
      { dynamic: true, text: 'Could not load' }
    ])
  })

  it('finds arbitrary doctype documents and template-literal insertHTML copy', () => {
    const source = [
      'export const HTML = `<!doctype html>',
      '<main>Diagram controls</main>',
      '<script>',
      "document.execCommand('insertHTML', false, \\`<p>Retry ${name}</p><p>Follow up</p>\\`);",
      '</script>',
      '`'
    ].join('\n')
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/pr-sidebar/MermaidDiagram.tsx',
      source,
      '/repo'
    )

    expect(candidates.map(({ dynamic, text }) => ({ dynamic, text }))).toEqual([
      { dynamic: false, text: 'Diagram controls' },
      { dynamic: true, text: 'Retry' },
      { dynamic: false, text: 'Follow up' }
    ])
  })

  it('finds literals assigned to variables that later render in JSX', () => {
    const source = `
export function Example({ alternate }) {
  const copy = alternate ? 'Primary explanation' : 'Alternate explanation'
  let followUp = 'Initial recovery note'
  const fileLocation = \`\${path}:L\${line}\`
  if (alternate) {
    followUp = 'Updated recovery note'
  }
  return <><Text>{copy}</Text><Text>{followUp}</Text><Text>{fileLocation}</Text></>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'Primary explanation',
      'Alternate explanation',
      'Initial recovery note',
      'Updated recovery note'
    ])
  })

  it('uses only assignments that can reach a rendered variable', () => {
    const source = `
export function Example() {
  let label = 'Dead initial value'
  label = 'Actually rendered value'
  return <Text>{label}</Text>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Actually rendered value'])
  })

  it('finds direct and assigned literals in user-visible JSX attributes', () => {
    const source = `
export function Example() {
  const copy = 'Save changes'
  const className = 'not-visible-copy'
  return <><Button title={copy} className={className} /><Button title={'Direct save'!} /><Button title={('Open menu' as string)} /><Button title={('Choose host' satisfies string)} /></>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'Save changes',
      'Direct save',
      'Open menu',
      'Choose host'
    ])
  })

  it('finds unlocalized success-toast object copy', () => {
    const source = `
export const launch = {
  options: { successToast: 'Quick command inserted' }
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/terminal/quick-commands.ts',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Quick command inserted'])
  })

  it('finds unlocalized fallbacks returned by commentAuthor', () => {
    const source = `
function commentAuthor(comment) {
  return comment.author ?? 'unknown'
}
export function Example({ comment }) {
  return <Text>{commentAuthor(comment)}</Text>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/app/h/[hostId]/tasks.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['unknown'])
  })

  it('finds copy returned by a helper whose result is rendered', () => {
    const source = `
function lookup() {
  return 'Extracting model'
}
function internalValue() {
  return 'internal-only'
}
function projectRowType() {
  return 'issue'
}
export function Example() {
  const render = lookup
  return <>{projectRowType() ? <Text>{render()}</Text> : null}</>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Extracting model'])
  })

  it('finds copy returned through a rendered helper object', () => {
    const source = `
function lookup() {
  return 'Extracting object model'
}
export function Example() {
  const renderers = { lookup }
  return <Text>{renderers.lookup()}</Text>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Extracting object model'])
  })

  it('finds member, assigned, destructured, and inline rendered helpers', () => {
    const source = `
function lookup() {
  return 'Member alias raw copy'
}
const renderers = { lookup, inline: () => 'Inline member raw copy' }
const render = renderers.lookup
let assigned
assigned = renderers.lookup
const { inline } = renderers
export function Example() {
  return <><Text>{render()}</Text><Text>{assigned()}</Text><Text>{inline()}</Text></>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'Member alias raw copy',
      'Inline member raw copy'
    ])
  })

  it('uses the last effective rendered-helper property', () => {
    const source = `
function lookup() {
  return 'Dead helper raw copy'
}
const base = { lookup }
const renderers = { ...base, lookup: () => 'Visible replacement raw copy' }
export function Example() {
  return <Text>{renderers.lookup()}</Text>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Visible replacement raw copy'])
  })

  it('matches rendered variables by binding instead of identifier text', () => {
    const source = `
const value = 'internal mode name'
export function Example() {
  const value = 'Visible nested value'
  return <Text>{value}</Text>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Visible nested value'])
  })

  it('finds Android notification-channel names', () => {
    const source = `
const channel = {
  name: 'Desktop Notifications',
  importance: Notifications.AndroidImportance.HIGH
}
Notifications.setNotificationChannelAsync('orca-desktop', channel)
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/notifications/local-notification-scheduling.ts',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Desktop Notifications'])
  })

  it('finds bound and spread Android notification-channel names', () => {
    const source = `
const channelName = 'Desktop Notifications'
const channel = { name: channelName }
const baseChannel = { name: 'Background Notifications' }
const spreadChannel = { ...baseChannel }
Notifications.setNotificationChannelAsync('orca-desktop', channel)
Notifications.setNotificationChannelAsync('orca-background', spreadChannel)
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/notifications/local-notification-scheduling.ts',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'Desktop Notifications',
      'Background Notifications'
    ])
  })

  it('uses assigned and last-written notification names without descending calls', () => {
    const source = `
let assignedName
assignedName = 'Assigned channel name'
const base = { name: 'Dead fallback name' }
const assigned = { name: assignedName }
const overridden = { ...base, name: 'Actual desktop name' }
const computed = { name: makeName('Not itself the channel name') }
const assignedAfterCreation = {}
assignedAfterCreation.name = 'Assigned after creation'
Notifications.setNotificationChannelAsync('assigned', assigned)
Notifications.setNotificationChannelAsync('overridden', overridden)
Notifications.setNotificationChannelAsync('computed', computed)
Notifications.setNotificationChannelAsync('after-creation', assignedAfterCreation)
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/notifications/local-notification-scheduling.ts',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'Assigned channel name',
      'Actual desktop name',
      'Assigned after creation'
    ])
  })

  it('keeps OS-visible channel names when a later assignment reaches JSX', () => {
    const source = `
let channelName = 'OS-visible channel name'
const channel = { name: channelName }
Notifications.setNotificationChannelAsync('desktop', channel)
channelName = 'Later rendered value'
export const label = <Text>{channelName}</Text>
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/notifications/local-notification-scheduling.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'OS-visible channel name',
      'Later rendered value'
    ])
  })

  it('reports raw copy from a namespace-local translator', () => {
    const source = `
import { t } from '@/i18n/mobile-i18n'
namespace Local {
  var t = (value) => value
  export const label = <Text>{t('Namespace raw copy')}</Text>
}
export const translated = t('example.translated')
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Namespace raw copy'])
  })

  it('reports raw copy from a class-static-block translator shadow', () => {
    const source = `
import { t } from '@/i18n/mobile-i18n'
class Example {
  static {
    var t = (value) => value
    const label = <Text>{t('Static block raw copy')}</Text>
  }
}
export const translated = t('example.translated')
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Static block raw copy'])
  })

  it('reports a rendered call after a translator alias is replaced', () => {
    const source = `
import { t } from '@/i18n/mobile-i18n'
let tr = t
tr = (value) => value
export const label = <Text>{tr('Visible raw copy')}</Text>
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Visible raw copy'])
  })

  it('reports rendered member and logical calls after translator replacement', () => {
    const source = `
import { t } from '@/i18n/mobile-i18n'
const box = { tr: t }
box.tr = (value) => value
let logical = t
logical &&= (value) => value
let closure = t
const closureBox = { tr: t }
function Later() { return <><Text>{closure('Scalar closure raw')}</Text><Text>{closureBox.tr('Member closure raw')}</Text></> }
closure = (value) => value
closureBox.tr = (value) => value
const a = { tr: t }
const b = { tr: (value) => value }
let y = a
y &&= b
a.tr = y.tr
export const label = <><Text>{box.tr('Member raw copy')}</Text><Text>{logical('Logical raw copy')}</Text><Text>{a.tr('Ambiguous property raw')}</Text><Later /></>
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'Scalar closure raw',
      'Member closure raw',
      'Member raw copy',
      'Logical raw copy',
      'Ambiguous property raw'
    ])
  })

  it('reports non-null renders and raw calls after snapshot or member mutations', () => {
    const source = `
import { t } from '@/i18n/mobile-i18n'
const raw = (value) => value
let source = raw
const snapshot = source
source = t
const box = { tr: t }
const alias = box
alias.tr = raw
const holder = { inner: { tr: t } }
holder.inner.tr = raw
let objectSource = { tr: raw }
const objectSnapshot = objectSource
objectSource = { tr: t }
const visible = 'Visible non-null copy'
function render() { return 'Helper non-null copy' }
export const label = <><Text>{snapshot('Raw snapshot copy')}</Text><Text>{box.tr('Raw alias mutation')}</Text><Text>{holder.inner.tr('Raw nested mutation')}</Text><Text>{objectSnapshot.tr('Raw object snapshot')}</Text><Text>{visible!}</Text><Text>{'Direct non-null copy'!}</Text><Text>{render!()}</Text></>
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'Visible non-null copy',
      'Helper non-null copy',
      'Raw snapshot copy',
      'Raw alias mutation',
      'Raw nested mutation',
      'Raw object snapshot',
      'Direct non-null copy'
    ])
  })

  it('finds user-visible subject fallbacks in returned rows', () => {
    const source = `
export function toRow(item) {
  return { subject: item.subject || '(no commit message)' }
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/source-control/mobile-git-history.ts',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['(no commit message)'])
  })

  it('recognizes aliased translators and reports calls shadowed by parameters', () => {
    const source = `
import { t as translateMobile } from '@/i18n/mobile-i18n'
import * as i18n from '@/i18n/mobile-i18n'
const localized = translateMobile('example.localized')
export function Example(translateMobile) {
  return <Text>{translateMobile('Unlocalized shadowed copy')}</Text>
}
export function MemberExample(i18n) {
  return <Text>{i18n.t('Unlocalized shadowed member copy')}</Text>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'Unlocalized shadowed copy',
      'Unlocalized shadowed member copy'
    ])
  })

  it('reports calls shadowing a prefixed translator alias', () => {
    const source = `
import { createMobileTranslator } from '@/i18n/mobile-i18n'
const translateExample = createMobileTranslator('example')
export function Example(translateExample) {
  return <Text>{translateExample('Shadowed prefixed raw copy')}</Text>
}
`
    const candidates = collectLocalizationCandidates(
      '/repo/mobile/src/components/Example.tsx',
      source,
      '/repo'
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(['Shadowed prefixed raw copy'])
  })

  it('rejects stale allowlist entries before their approval can be reused', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-localization-allowlist-'))
    const sourceDirectory = path.join(root, 'mobile', 'src')
    const configDirectory = path.join(root, 'config')
    mkdirSync(sourceDirectory, { recursive: true })
    mkdirSync(configDirectory, { recursive: true })
    writeFileSync(path.join(sourceDirectory, 'Example.tsx'), "export const value = 'internal'\n")
    writeFileSync(
      path.join(configDirectory, 'allowlist.json'),
      `${JSON.stringify([
        {
          filePath: 'mobile/src/Example.tsx',
          kind: 'jsx-text',
          text: 'Removed approved copy',
          dynamic: false,
          count: 1
        }
      ])}\n`
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await expect(
        auditLocalizationCoverage(root, [
          '--check',
          '--source-root',
          'mobile/src',
          '--allowlist',
          'config/allowlist.json'
        ])
      ).resolves.toBe(1)
      expect(error.mock.calls.flat().join('\n')).toContain(
        'Stale localization allowlist entries were found.'
      )
    } finally {
      error.mockRestore()
    }
  })
})
