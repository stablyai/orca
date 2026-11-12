import { request } from 'node:http'

/** Expected callback coordinates from the server’s sign-in link. */
export type AntigravitySignInPending = { redirectUri: string; state: string }

const NOT_THIS_SIGN_IN = 'This redirect URL does not belong to the current sign-in.'

/** Validate the pasted callback before forwarding anything to a host port. */
export function antigravitySignInCallback(
  pending: AntigravitySignInPending,
  callbackUrl: string
): URL {
  if (callbackUrl.length > 16_384) {
    throw new Error('The sign-in response URL is too long.')
  }
  const text = callbackUrl.trim()
  if (!URL.canParse(text)) {
    throw new Error('Paste the complete redirect URL from the Google sign-in page.')
  }
  const callback = new URL(text)
  const expected = new URL(pending.redirectUri)
  const all = (name: string): string[] => callback.searchParams.getAll(name)
  const [codes, errors, issuers] = [all('code'), all('error'), all('iss')]
  if (
    callback.protocol !== 'http:' ||
    callback.hostname !== '127.0.0.1' ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username !== '' ||
    callback.password !== '' ||
    callback.hash !== '' ||
    all('state').length !== 1 ||
    callback.searchParams.get('state') !== pending.state
  ) {
    throw new Error(NOT_THIS_SIGN_IN)
  }
  const oneAnswer =
    (codes.length === 1 && codes[0] !== '' && errors.length === 0) ||
    (errors.length === 1 && errors[0] !== '' && codes.length === 0)
  if (!oneAnswer) {
    throw new Error('The redirect URL must contain one Google sign-in response.')
  }
  if (issuers.some((issuer) => issuer !== 'https://accounts.google.com') || issuers.length > 1) {
    throw new Error('The redirect URL is not a Google sign-in response.')
  }
  return callback
}

/** Send an abortable GET to the validated loopback callback. */
export function sendAntigravitySignInCallback(
  callback: URL,
  flow: AbortSignal,
  timeoutMs = 10_000
): Promise<void> {
  const signal = AbortSignal.any([flow, AbortSignal.timeout(timeoutMs)])
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        hostname: callback.hostname,
        port: callback.port,
        path: `${callback.pathname}${callback.search}`,
        method: 'GET',
        agent: false
      },
      (response) => {
        response.once('error', reject)
        response.once('end', () => {
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) {
            resolve()
          } else {
            reject(new Error(`The sign-in listener answered ${status}.`))
          }
        })
        response.resume()
      }
    )
    const stop = (): void => {
      reject(new Error('Sending the sign-in address was stopped.'))
      sent.destroy()
    }
    signal.addEventListener('abort', stop, { once: true })
    sent.once('close', () => signal.removeEventListener('abort', stop))
    sent.once('error', reject)
    sent.end()
  })
}
