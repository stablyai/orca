import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import { MAX_SSH_SERVICE_LINKS } from '../../../shared/ssh-service-links'
import { normalizeSshTarget } from './ssh-normalization'

function target(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'ssh-1',
    label: 'build-box',
    host: 'build-box.example.ts.net',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

describe('normalizeSshTarget service links', () => {
  it('keeps persisted http(s) links, trimmed', () => {
    const normalized = normalizeSshTarget(
      target({
        serviceLinks: [{ label: ' Grafana ', url: ' https://build-box.example.ts.net ' }]
      })
    )

    expect(normalized.serviceLinks).toEqual([
      { label: 'Grafana', url: 'https://build-box.example.ts.net' }
    ])
  })

  it('drops non-http(s) and over-long entries on load', () => {
    const normalized = normalizeSshTarget(
      target({
        serviceLinks: [
          { label: 'Grafana', url: 'https://grafana.example' },
          { label: 'Bad scheme', url: 'javascript:alert(1)' },
          { label: 'Local file', url: 'file:///etc/passwd' },
          { label: 'x'.repeat(61), url: 'https://too-long-label.example' }
        ]
      })
    )

    expect(normalized.serviceLinks).toEqual([{ label: 'Grafana', url: 'https://grafana.example' }])
  })

  it('caps a persisted list at the link maximum', () => {
    const normalized = normalizeSshTarget(
      target({
        serviceLinks: Array.from({ length: MAX_SSH_SERVICE_LINKS + 3 }, (_, index) => ({
          label: `service-${index}`,
          url: `https://service-${index}.example`
        }))
      })
    )

    expect(normalized.serviceLinks).toHaveLength(MAX_SSH_SERVICE_LINKS)
  })

  it('removes the field when nothing usable is left', () => {
    expect(normalizeSshTarget(target()).serviceLinks).toBeUndefined()
    expect(normalizeSshTarget(target({ serviceLinks: [] })).serviceLinks).toBeUndefined()
    expect(
      normalizeSshTarget(target({ serviceLinks: [{ label: '', url: 'https://a.example' }] }))
    ).not.toHaveProperty('serviceLinks')
  })
})
