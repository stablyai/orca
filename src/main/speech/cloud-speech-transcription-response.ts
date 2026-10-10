import { z } from 'zod'

/** Response body of the multipart transcription endpoints (ElevenLabs, Mistral). */
export const TEXT_TRANSCRIPTION_RESPONSE = z.object({ text: z.string() })

export function invalidTranscriptionResponse(label: string): Error {
  return new Error(`${label} returned an invalid transcription response`)
}

/** Reads a 2xx provider body and checks its shape; providers can change JSON under us. */
export async function readTranscriptionJson<Schema extends z.ZodType>(
  label: string,
  response: Response,
  schema: Schema
): Promise<z.infer<Schema>> {
  const body: unknown = await response.json().catch(() => undefined)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw invalidTranscriptionResponse(label)
  }
  return parsed.data
}
