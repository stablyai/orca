import { generateKeyPairSync, createHash } from 'node:crypto'
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const der = publicKey.export({ type: 'spki', format: 'der' })
const keyB64 = der.toString('base64')
const hash = createHash('sha256').update(der).digest('hex').slice(0, 32)
const id = hash.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
console.log('manifest.key =', keyB64)
console.log('CHAT_IMPORT_EXTENSION_ID =', id)
