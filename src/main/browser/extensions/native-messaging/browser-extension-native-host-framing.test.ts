import { expect, it } from 'vitest'
import {
  createNativeHostMessageReader,
  encodeNativeHostMessage
} from './browser-extension-native-host-framing'

it('refuses malformed UTF-8 instead of delivering silently replaced JSON text', () => {
  const messages: string[] = []
  const errors: string[] = []
  const reader = createNativeHostMessageReader(
    (message) => messages.push(message),
    (error) => errors.push(error)
  )
  const valid = encodeNativeHostMessage('{"value":"�"}')
  expect(reader.push(valid)).toBe(true)

  const malformed = Buffer.from(valid)
  malformed[malformed.indexOf(Buffer.from('�'))] = 0xff
  expect(reader.push(malformed)).toBe(false)
  expect(reader.push(valid)).toBe(false)
  expect(messages).toEqual(['{"value":"�"}'])
  expect(errors).toEqual(['message is not valid JSON'])
})
