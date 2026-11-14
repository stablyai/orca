// Sec-MS-GEC v2. Microsoft started requiring it in October 2026; without it the
// speech socket is refused with 403. The digest matches edge-tts 7.3.1, including
// the captured vector for unix time 1791888000.

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WIN_EPOCH = 11644473600
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2
]
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564
]
const ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]
const ADJUSTMENT = 0xc9dc06a7
const BLOCK_CONSTANTS = ROUND.slice(0, 14).concat([ADJUSTMENT], ROUND.slice(15))
const SIGMA0_ADJUSTMENT = 0x059c0b80
const SIGMA1_ADJUSTMENT = 0x000b92c0
const CS64_COEFFICIENTS: readonly (readonly [number, number])[] = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167]
]
const CS64_FACTOR = 0x82893933
const CS64_ADJUSTMENT0 = 0xf2f90b1a
const CS64_ADJUSTMENT1 = 0x0b1a0000

export const EDGE_TTS_GEC_VERSION = '2-143.0.3650.75'
export const EDGE_TTS_TRUSTED_CLIENT_TOKEN = TRUSTED_CLIENT_TOKEN

const unsigned = (value: number): number => value >>> 0
const mul = (left: number, right: number): number => Math.imul(left, right) >>> 0

function rotateLeft16(value: number): number {
  const bits = unsigned(value)
  return unsigned((bits << 16) | (bits >>> 16))
}

function rotateRight(value: number, bits: number): number {
  return unsigned((value >>> bits) | (value << (32 - bits)))
}

function sigma0(value: number): number {
  return unsigned((value >>> 7) ^ (value << 25) ^ (value >>> 18) ^ (value << 14) ^ (value >>> 3))
}

function sigma1(value: number): number {
  return unsigned((value >>> 17) ^ (value << 15) ^ (value >>> 19) ^ (value << 13) ^ (value >>> 10))
}

function sha256Rounds(state: number[], words: number[], firstRound: number): number[] {
  let [a, b, c, d, e, f, g, h] = state
  const constants = firstRound === 14 ? BLOCK_CONSTANTS : ROUND
  for (let index = firstRound; index < 64; index += 1) {
    const choice = g! ^ (e! & (f! ^ g!))
    const t1 = unsigned(
      h! +
        (rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25)) +
        choice +
        constants[index]! +
        words[index]!
    )
    const majority = (a! & b!) | (c! & (a! | b!))
    const t2 = unsigned((rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22)) + majority)
    ;[a, b, c, d, e, f, g, h] = [unsigned(t1 + t2), a, b, c, unsigned(d! + t1), e, f, g]
  }
  return [a!, b!, c!, d!, e!, f!, g!, h!]
}

function expandSchedule(words: number[], firstWord = 16): void {
  for (let index = firstWord; index < 64; index += 1) {
    words.push(
      unsigned(
        sigma1(words[index - 2]!) +
          words[index - 7]! +
          sigma0(words[index - 15]!) +
          words[index - 16]!
      )
    )
  }
}

function sha256Init(data: Buffer): number[] {
  const words = Array.from({ length: 14 }, () => 0)
  words.push((data[0]! << 16) | (data[1]! << 8) | data[2]!)
  words.push((data[3]! << 24) | (data[4]! << 16) | (data[5]! << 8) | data[6]!)
  for (let index = 16; index < 30; index += 1) {
    let value = SHA256_SCHEDULE[index - 16]!
    if (index - 2 >= 14) {
      const mixed = sigma1(words[index - 2]!)
      value += index === 16 ? mixed ^ SIGMA1_ADJUSTMENT : mixed
    }
    if (index - 7 >= 14) {
      value += words[index - 7]!
    }
    if (index - 15 >= 14) {
      const mixed = sigma0(words[index - 15]!)
      value += index === 29 ? mixed ^ SIGMA0_ADJUSTMENT : mixed
    }
    words.push(unsigned(value))
  }
  words.push(
    unsigned(
      sigma1(words[28]!) + words[23]! + sigma0(words[15]!) + words[14]! + ADJUSTMENT - ROUND[14]!
    )
  )
  expandSchedule(words, 31)
  const working = sha256Rounds(SHA256_STATE, words, 14)
  return SHA256_INITIAL.map((value, index) => unsigned(value + working[index]!))
}

function sha256Digest(data: Buffer): Buffer {
  const length = 57 + data.length
  const padLength = (55 - length) % 64
  const zeroCount = padLength < 0 ? padLength + 64 : padLength
  const padded = Buffer.alloc(data.length - 7 + 1 + zeroCount + 8)
  data.subarray(7).copy(padded, 0)
  padded[data.length - 7] = 0x80
  padded.writeBigUInt64BE(BigInt(length * 8), padded.length - 8)
  let state = sha256Init(data)
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = []
    for (let index = 0; index < 16; index += 1) {
      words.push(padded.readUInt32BE(offset + index * 4))
    }
    expandSchedule(words)
    const working = sha256Rounds(state, words, 0)
    state = state.map((value, index) => unsigned(value + working[index]!))
  }
  const digest = Buffer.alloc(32)
  for (let index = 0; index < state.length; index += 1) {
    digest.writeUInt32BE(state[index]!, index * 4)
  }
  return digest
}

function littleEndianWords(data: Buffer): number[] {
  const size = data.length + ((4 - (data.length % 4)) % 4)
  const padded = Buffer.alloc(size)
  data.copy(padded)
  const words: number[] = []
  for (let offset = 0; offset < padded.length; offset += 4) {
    words.push(padded.readUInt32LE(offset))
  }
  if (words.length % 2 === 1) {
    words.push(0)
  }
  return words
}

function cs64Digest(data: Buffer, digest: Buffer): [number, number] {
  const keyA = digest.readUInt32LE(0) | 1
  const keyB = digest.readUInt32LE(4) | 1
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)]
  const terms = CS64_COEFFICIENTS.map(([coefficient], index) =>
    mul(coefficient, factors[index % 2]!)
  )
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset)
  const payloadWords = littleEndianWords(Buffer.concat([Buffer.from([0]), data]))
  for (let index = 0; index < payloadWords.length; index += 1) {
    const word = payloadWords[index]!
    const key = index % 2 === 0 ? keyA : keyB
    let term = mul(word, key)
    let offset = mul(rotateLeft16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db)
    if (index === 0) {
      term = unsigned(term + mul(CS64_ADJUSTMENT0, factors[0]!))
      offset = unsigned(offset + CS64_ADJUSTMENT1)
    }
    terms.push(unsigned(term))
    offsets.push(unsigned(offset))
  }
  let swapAccumulator = 0
  let swapLast = 0
  let state = 0
  let accumulator = 0
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index]!
    const y = terms[index + 1]!
    let rotated = rotateLeft16(unsigned(offsets[index]! + x))
    let mixed = mul(rotated, 0x76f50f34)
    swapAccumulator = unsigned(
      swapAccumulator + unsigned(mul(rotateLeft16(mixed), 0xc3efea97) + mixed)
    )
    rotated = rotateLeft16(unsigned(offsets[index + 1]! + y))
    mixed = mul(rotated, 0x1881ce3c)
    swapLast = unsigned(mul(rotateLeft16(mixed), 0x35bd1ec9) + mixed)
    swapAccumulator = unsigned(swapAccumulator + swapLast)
    state = unsigned(mul(state, keyA) + x)
    state = mul(rotateLeft16(state), 0xcf98b111)
    state = mul(rotateLeft16(state), 0x87085b9f)
    state = mul(rotateLeft16(state), 0x12ceb96d)
    state = mul(rotateLeft16(state), 0x257e1d83)
    accumulator = unsigned(accumulator + state)
    let mixedState = unsigned(mul(state, keyB) + y)
    mixedState = mul(rotateLeft16(mixedState), 0xa27416f5)
    mixedState = mul(rotateLeft16(mixedState), 0xd38396ff)
    state = mul(rotateLeft16(mul(rotateLeft16(mixedState), 0x7c932b89)), 0xbfa49f69)
    accumulator = unsigned(accumulator + state)
  }
  return [unsigned(swapLast ^ state), unsigned(swapAccumulator ^ accumulator)]
}

/** Token for one five-minute window. `unixSeconds` is injectable for the captured vector. */
export function edgeSecMsGec(unixSeconds = Date.now() / 1000): string {
  let ticks = unixSeconds + WIN_EPOCH
  ticks -= ticks % 300
  ticks *= 1e7
  const data = Buffer.from(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
  const digest = sha256Digest(data)
  const [first, second] = cs64Digest(data, digest)
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(first, 0)
  prefix.writeUInt32LE(second, 4)
  return `${prefix.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`
}

export function edgeTtsWebSocketUrl(connectionId: string, unixSeconds = Date.now() / 1000): string {
  const params = new URLSearchParams({
    TrustedClientToken: EDGE_TTS_TRUSTED_CLIENT_TOKEN,
    ConnectionId: connectionId,
    'Sec-MS-GEC': edgeSecMsGec(unixSeconds),
    'Sec-MS-GEC-Version': EDGE_TTS_GEC_VERSION
  })
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?${params}`
}
