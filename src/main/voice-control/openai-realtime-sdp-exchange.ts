import type { MainHttpClient } from '../network/http-client'
import { VoiceControlRealtimeError } from './voice-control-realtime-error'

/**
 * Relays the renderer's SDP offer to OpenAI and returns the answer plus the
 * provider-assigned call id. Authenticates as the call itself via the ephemeral client
 * secret — never the real API key.
 */

export type RealtimeSdpExchange = {
  answerSdp: string
  callId: string
}

export async function exchangeRealtimeSdpOffer(
  http: Pick<MainHttpClient, 'fetch'>,
  clientSecret: string,
  offerSdp: string
): Promise<RealtimeSdpExchange> {
  let response: Response
  try {
    response = await http.fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp'
      },
      body: offerSdp
    })
  } catch (error) {
    throw VoiceControlRealtimeError.fromFetchFailure(error)
  }
  // Why exactly-201: the only validated wire contract here is 201 + Location, not "any
  // 2xx" — call_id provenance is security-relevant (otto#4297 spike).
  if (response.status !== 201) {
    throw await VoiceControlRealtimeError.fromHttpResponse(response)
  }
  const location = response.headers.get('Location') ?? ''
  const segments = location.replace(/\/+$/, '').split('/')
  const callId = segments.at(-2) === 'calls' ? (segments.at(-1) ?? '') : ''
  if (!callId) {
    throw new VoiceControlRealtimeError(
      'unknown',
      `realtime calls response missing a usable Location header: ${JSON.stringify(location)}`
    )
  }
  const answerSdp = await response.text()
  if (!answerSdp.trim()) {
    throw new VoiceControlRealtimeError(
      'unknown',
      'realtime calls response had an empty SDP answer'
    )
  }
  return { answerSdp, callId }
}
