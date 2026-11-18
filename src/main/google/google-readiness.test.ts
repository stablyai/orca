import { describe, expect, it } from 'vitest'
import { GOOGLE_SERVICE_CHOICES, googleSignInScopes } from '../../shared/google/google-scopes'

const GOOGLE_SIGN_IN_SCOPES = googleSignInScopes(GOOGLE_SERVICE_CHOICES)
import { checkGoogleServices } from './google-readiness'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

async function stateOf(service: string, answer: Response) {
  const results = await checkGoogleServices({
    http: async (input) => (String(input).includes(service) ? answer.clone() : json(200, {})),
    accessToken: 'at',
    grantedScopes: GOOGLE_SIGN_IN_SCOPES,
    choices: GOOGLE_SERVICE_CHOICES,
    projectId: 'acme'
  })
  return results.find((result) => result.service === service.split('.')[0])
}

describe('each Google service’s readiness', () => {
  it('reads an API turned off in the older error shape, with the Console page in the project', async () => {
    expect(
      await stateOf(
        'gmail',
        json(403, {
          error: {
            code: 403,
            message: 'Access Not Configured.',
            errors: [{ reason: 'accessNotConfigured' }]
          }
        })
      )
    ).toEqual({
      service: 'gmail',
      state: 'api-disabled',
      detail: 'The Gmail API is turned off in your Google project.',
      enableUrl: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=acme'
    })
  })

  it('reads a scope Google did not grant as Needs permission', async () => {
    expect(
      await stateOf(
        'drive',
        json(403, {
          error: {
            message: 'Request had insufficient authentication scopes.',
            details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }]
          }
        })
      )
    ).toMatchObject({ state: 'needs-permission' })
  })

  it('reads a service the company turned off as Blocked by admin', async () => {
    expect(
      await stateOf(
        'gmail',
        json(400, { error: { message: 'Mail service not enabled', status: 'FAILED_PRECONDITION' } })
      )
    ).toMatchObject({ state: 'blocked-by-admin', detail: 'Mail service not enabled' })
  })

  it('ignores an activation link that is not Google’s Console', async () => {
    const result = await stateOf(
      'drive',
      json(403, {
        error: {
          details: [
            { reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://evil.example/' } }
          ]
        }
      })
    )
    expect(result?.enableUrl).toBe(
      'https://console.cloud.google.com/apis/library/drive.googleapis.com?project=acme'
    )
  })

  it('says not working when Google cannot be reached', async () => {
    const results = await checkGoogleServices({
      http: async () => {
        throw new TypeError('fetch failed')
      },
      accessToken: 'at',
      grantedScopes: GOOGLE_SIGN_IN_SCOPES,
      choices: GOOGLE_SERVICE_CHOICES
    })
    expect(new Set(results.map((result) => result.state))).toEqual(new Set(['error']))
  })
})
