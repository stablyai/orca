import { describe, expect, it } from 'vitest'
import { parseSshConfig } from './ssh-config-parser'

describe('parseSshConfig host pattern filtering', () => {
  it('ignores negated aliases on mixed Host lines', () => {
    const config = `
Host prod !prod-admin
  HostName prod.example.com
`
    expect(parseSshConfig(config)).toEqual([{ host: 'prod', hostname: 'prod.example.com' }])
  })

  it('imports only literal positive aliases from mixed wildcard and negated patterns', () => {
    const config = `
Host !legacy *.corp prod
  HostName prod.example.com
`
    expect(parseSshConfig(config)).toEqual([{ host: 'prod', hostname: 'prod.example.com' }])
  })

  it('ignores inline comments on mixed Host lines', () => {
    const config = `
Host prod stage # shared production aliases
  HostName prod.example.com
`
    expect(parseSshConfig(config)).toEqual([
      { host: 'prod', hostname: 'prod.example.com' },
      { host: 'stage', hostname: 'prod.example.com' }
    ])
  })

  it('skips Host entries containing only wildcard and negated patterns', () => {
    const config = `
Host !legacy *.corp ??
  HostName ignored.example.com
`
    expect(parseSshConfig(config)).toEqual([])
  })
})
