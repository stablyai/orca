import { describe, expect, it } from 'vitest'
import { gmailLinksAccount, parseGmailRef } from './google-gmail-ref'

const link = (path: string) => `https://mail.google.com/mail/u/1/#inbox/${path}`

describe('parseGmailRef', () => {
  it('takes the hex API id at the end of a link', () => {
    expect(parseGmailRef(link('1A21112A62173574'))).toEqual({
      kind: 'thread',
      id: '1a21112a62173574'
    })
    expect(parseGmailRef('https://mail.google.com/mail/u/0/#label/Work/16426a350b26c62c')).toEqual({
      kind: 'thread',
      id: '16426a350b26c62c'
    })
  })

  // Published token/id pairs (Arsenal Recon, Gmail URL Decoder, 2019), plus a current FMfcgz link
  // whose older form ends in 1a21112a62173574.
  it.each([
    ['FMfcgzQjgzwmbqClhRLNqvmkvzZLPZdL', '1a21112a62173574'],
    ['FMfcgxvwzcMvCVqtTprDSvtNVBhnMBzq', '16426a350b26c62c'],
    ['FMfcgxvwzRXLNMWwJgdjMFzrQGrPLLSF', '163be85d78c6008b'],
    ['FMfcgxmZVXvrWPNgNTwdRlPCnJbFddNt', '1631f9c3a74cd345'],
    ['FMfcgxRvprtNNfKFPzvXTwHcmpvzKwZB', '12f356c653c78c4c']
  ])('decodes the view token %s to thread %s', (token, id) => {
    expect(parseGmailRef(`${link(token)}?projector=1`)).toEqual({ kind: 'thread', id })
  })

  it('refuses a token with no API id and points to search', () => {
    // A "thread-a:" token (mail sent from the new UI), and consonants that decode to nothing.
    for (const token of ['FFNDWLvlXsCvcpmszhgMDVsFSpjtQQCM', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB']) {
      expect(() => parseGmailRef(link(token))).toThrow(/orca gmail search.*rfc822msgid:/)
    }
  })
})

describe('gmailLinksAccount', () => {
  const accounts =
    (...emails: string[]) =>
    () =>
      Promise.resolve(emails)

  it('uses the account a link names', async () => {
    const named = 'https://mail.google.com/mail/?authuser=Ada%40acme.dev#all/1a21112a62173574'
    await expect(gmailLinksAccount([named], accounts('a@x.dev', 'b@x.dev'))).resolves.toBe(
      'ada@acme.dev'
    )
  })

  it('takes the only account for a /u/N/ link and refuses to guess among several', async () => {
    const slot = link('1a21112a62173574')
    await expect(gmailLinksAccount([slot], accounts('a@x.dev'))).resolves.toBe('a@x.dev')
    await expect(gmailLinksAccount([slot], accounts('a@x.dev', 'b@x.dev'))).rejects.toThrow(
      'Pass --account with one of: a@x.dev, b@x.dev.'
    )
  })

  it('leaves the default for refs that are not links', async () => {
    await expect(
      gmailLinksAccount(['gmail:thread:1a21112a62173574'], accounts('a@x.dev', 'b@x.dev'))
    ).resolves.toBeUndefined()
  })
})
