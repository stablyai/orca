import { afterEach, describe, expect, it, vi } from 'vitest'
import { SUPPORTED_UI_LOCALES } from '../../../src/shared/ui-locale'
import { activateMobileUiLocale, translate } from '../i18n/mobile-i18n'
import { troubleshootCommonIssues } from './troubleshoot-common-issues'

vi.mock('lucide-react-native', () => ({
  WifiOff: () => null,
  Shield: () => null,
  Monitor: () => null,
  Clock: () => null,
  Globe: () => null,
  Bell: () => null
}))

afterEach(() => activateMobileUiLocale('en'))

describe('troubleshooting firewall advice', () => {
  it.each([
    { endpoints: ['ws://192.168.1.10:6769'], ports: ['6769'] },
    { endpoints: ['ws://[fd7a:115c:a1e0::1]:7777'], ports: ['7777'] },
    { endpoints: ['wss://desktop.example', 'ws://desktop.local'], ports: ['443', '80'] },
    { endpoints: [], ports: ['6768'] },
    { endpoints: ['invalid endpoint'], ports: ['6768'] },
    {
      endpoints: ['ws://first.local:6769', 'ws://second.local:7777', 'ws://third.local:6769'],
      ports: ['6769', '7777']
    }
  ])('uses paired ports for $endpoints', ({ endpoints, ports }) => {
    const sections = troubleshootCommonIssues(translate, endpoints).filter((section) =>
      section.id.startsWith('firewall')
    )
    expect(sections.map((section) => section.title)).toEqual(
      ports.map((port) => `Firewall Blocking Port ${port}`)
    )
    expect(sections.map((section) => section.steps.find((step) => step.includes('ufw')))).toEqual(
      ports.map((port) => `Linux: sudo ufw allow ${port}`)
    )
    expect(new Set(sections.map((section) => section.id)).size).toBe(ports.length)
  })

  it.each(SUPPORTED_UI_LOCALES)('interpolates the paired port in %s', async (locale) => {
    await activateMobileUiLocale(locale)
    const section = troubleshootCommonIssues(translate, ['ws://desktop.local:6769']).find((entry) =>
      entry.id.startsWith('firewall')
    )
    expect(section?.title).toContain('6769')
    expect(section?.title).not.toContain('6768')
    expect(section?.steps.some((step) => step.includes('sudo ufw allow 6769'))).toBe(true)
  })
})
