import { describe, expect, it } from 'vitest'
import { fetchFailureCode } from './environment-doctor-git'

const failed = (stderr: string, timedOut = false) => ({ code: 128, stdout: '', stderr, timedOut })

describe('fetchFailureCode', () => {
  it('names access refusals, including the egress firewall 403', () => {
    expect(
      fetchFailureCode(
        failed(
          "fatal: unable to access 'https://github.com/stablyai/orca-plugins/': The requested URL returned error: 403"
        )
      )
    ).toBe('remoteDenied')
    expect(
      fetchFailureCode(
        failed("fatal: could not read Username for 'https://github.com': terminal prompts disabled")
      )
    ).toBe('remoteDenied')
    expect(
      fetchFailureCode(failed("fatal: Authentication failed for 'https://github.com/o/r.git/'"))
    ).toBe('remoteDenied')
  })

  it("names GitHub's not found, which a private repo it won't confirm also gets", () => {
    expect(
      fetchFailureCode(
        failed(
          "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found"
        )
      )
    ).toBe('remoteNotFound')
  })

  it('names the network: DNS, connect, timeouts', () => {
    expect(
      fetchFailureCode(
        failed(
          "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"
        )
      )
    ).toBe('remoteUnreachable')
    expect(
      fetchFailureCode(
        failed(
          "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443"
        )
      )
    ).toBe('remoteUnreachable')
    expect(fetchFailureCode(failed('', true))).toBe('remoteUnreachable')
  })

  it('leaves wording it does not know without a code', () => {
    expect(fetchFailureCode(failed('fatal: something new'))).toBeUndefined()
  })
})
