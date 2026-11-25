// Google's own client file format, read and written only on the host that keeps the client: what an
// admin downloads (a "Desktop app" client), and what `orca google client export` hands a teammate.
import { z } from 'zod'
import {
  GOOGLE_CLIENT_FILE_MAX_BYTES,
  GOOGLE_CREDENTIALS_PAGE,
  type GoogleClientConfig
} from '../../shared/google/google-client-config'

const DESKTOP_CLIENT_STEPS = `In Google Cloud Console, open Credentials (${GOOGLE_CREDENTIALS_PAGE}), choose Create credentials › OAuth client ID › Desktop app, then download its file.`

const InstalledClient = z.object({
  client_id: z
    .string()
    .trim()
    .regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, 'bad client id'),
  client_secret: z.string().trim().min(1).max(512),
  project_id: z.string().trim().min(1).max(256).optional()
})

export type ParsedGoogleClient =
  | { ok: true; clientId: string; clientSecret: string; projectId?: string }
  | { ok: false; message: string }

const refuse = (message: string): ParsedGoogleClient => ({ ok: false, message })

/** Reads a client file downloaded from Google, saying what it is instead when it's the wrong kind. */
export function parseGoogleClientFile(text: string): ParsedGoogleClient {
  if (text.length > GOOGLE_CLIENT_FILE_MAX_BYTES) {
    return refuse(`This file is too large to be a Google client file. ${DESKTOP_CLIENT_STEPS}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return refuse(`This isn't a Google client file (it isn't JSON). ${DESKTOP_CLIENT_STEPS}`)
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return refuse(`This isn't a Google client file. ${DESKTOP_CLIENT_STEPS}`)
  }
  const type = 'type' in json ? json.type : undefined
  if (type === 'service_account') {
    return refuse(
      `This is a service-account key, which can't sign a person in. Choose a Desktop app client instead. ${DESKTOP_CLIENT_STEPS}`
    )
  }
  if (type === 'authorized_user' || 'refresh_token' in json || 'access_token' in json) {
    return refuse(
      `This is a saved Google sign-in, not a client file. Don't share it; Orca signs you in itself. ${DESKTOP_CLIENT_STEPS}`
    )
  }
  if ('web' in json) {
    return refuse(`This is a Web app client. Choose a Desktop app client. ${DESKTOP_CLIENT_STEPS}`)
  }
  if (!('installed' in json)) {
    return refuse(`This isn't a Google OAuth client file. ${DESKTOP_CLIENT_STEPS}`)
  }
  const installed = InstalledClient.safeParse(json.installed)
  if (!installed.success) {
    return refuse(
      `This Desktop app client file is missing its client id or secret. Download it again. ${DESKTOP_CLIENT_STEPS}`
    )
  }
  const { client_id: clientId, client_secret: clientSecret, project_id: projectId } = installed.data
  return { ok: true, clientId, clientSecret, ...(projectId ? { projectId } : {}) }
}

/** The client as Google's own Desktop app file, for a teammate to import. */
export function googleClientFile(
  config: Pick<GoogleClientConfig, 'clientId' | 'clientSecret' | 'projectId'>
): string {
  return `${JSON.stringify(
    {
      installed: {
        client_id: config.clientId,
        ...(config.projectId ? { project_id: config.projectId } : {}),
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        client_secret: config.clientSecret,
        redirect_uris: ['http://localhost']
      }
    },
    null,
    2
  )}\n`
}
