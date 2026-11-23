import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DesktopMobileE2EEV2Session } from '../../../../src/main/runtime/rpc/mobile/e2ee/mobile-e2ee-v2-desktop-session'
import { compressMobileE2EEV2Item } from '../../../../src/main/runtime/rpc/mobile/e2ee/mobile-e2ee-v2-compressed-frame'
import { successResponse } from '../../../../src/main/runtime/rpc/responses/rpc-success-response'
import type { MobileWebBundleCatalog } from '../../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  MOBILE_WEB_CATALOG_LEGACY_MAX_SEALED_BYTES,
  MOBILE_WEB_CATALOG_MAX_RESULT_BYTES,
  gzipCatalogResult,
  identityCatalogResult
} from '../../../../src/shared/mobile-web-bundle/catalog-reply-size'
import { NODE_COMPRESSED_FRAME_CODEC } from '../../../../src/shared/remote-runtime/e2ee/node/paired-e2ee-node-compressed-frame'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../src/shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import type { MobileE2EETransport } from '../../../../src/shared/remote-runtime/e2ee/mobile-e2ee-v2-contract'
import {
  COMPRESSED_FRAMES_CLIENT_CAPABILITY,
  inflateCompressedFrame
} from '../../../../src/shared/remote-runtime/e2ee/paired-e2ee-compressed-frame'
import { PairedE2EEV2ClientSession } from '../../../../src/shared/remote-runtime/e2ee/paired-e2ee-v2-client-session'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../../src/shared/remote-runtime/remote-runtime-memory-limits'
import { decodePageCatalogGzip } from '../../../../mobile/src/i18n/page-locale-catalog-gzip'
import { inflateCatalogGzip } from '../../../../mobile/src/i18n/catalog-gzip-member'
import { readBridgeHostMessage } from '../../../../mobile/src/mobile-web-shell/bridge/protocol/bridge-envelope'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_REPLY_BYTES
} from '../../../../mobile/src/mobile-web-shell/bridge/protocol/bridge-caps'
import { BridgeReplyAssembler } from '../../../../mobile/src/mobile-web-shell/bridge/protocol/bridge-reply-chunking'
import { createBridgeHostReplySender } from '../../../../mobile/src/mobile-web-shell/host-bridge/bridge-host-reply-sender'

const RUNTIME_ID = '00000000-0000-4000-8000-000000000000'
const BRIDGE_ID = '0'.repeat(22)
const RPC_SUFFIX = '9007199254740991--8640000000000000'

function createWire(transport: MobileE2EETransport) {
  const primitives = NODE_PAIRED_E2EE_PRIMITIVES
  const keys = primitives.generateKeyPair()
  const context = { transport, ...(transport === 'relay' && { relayHostId: 'catalog-proof-00' }) }
  const phone = PairedE2EEV2ClientSession.create({
    primitives,
    desktopPublicKeyB64: primitives.publicKeyToBase64(keys.publicKey),
    ...context
  })
  const desktop = DesktopMobileE2EEV2Session.create({
    hello: phone.hello,
    serverSecretKey: keys.secretKey,
    expectedContext: context
  })
  assert(desktop && phone.acceptReady(desktop.ready))
  const id = (transport === 'relay' ? 'relay-rpc-' : 'rpc-') + RPC_SUFFIX
  assert.equal(id.length, transport === 'relay' ? 44 : 38)
  return { desktop, phone, id }
}

function verifyReply(wire: ReturnType<typeof createWire>, result: unknown, legacy: boolean) {
  const reply = successResponse(wire.id, { runtimeId: RUNTIME_ID }, result)
  const text = JSON.stringify(reply)
  assert(Buffer.byteLength(text) <= REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES)
  assert(Buffer.byteLength(text) <= BRIDGE_MAX_REPLY_BYTES)
  const wireSizes: number[] = []
  for (const capabilities of [[], [COMPRESSED_FRAMES_CLIENT_CAPABILITY]] as const) {
    const frame = compressMobileE2EEV2Item({ kind: 'text', plaintext: text }, capabilities)
    if (frame.kind === 'text') {
      const sealed = wire.desktop.sealText(frame.plaintext)
      wireSizes.push(sealed.length)
      assert.equal(wire.phone.openText(sealed), text)
    } else {
      const sealed = wire.desktop.sealBinary(frame.plaintext)
      wireSizes.push(sealed.length)
      const opened = wire.phone.openBinary(sealed)
      assert(opened)
      assert.deepEqual(inflateCompressedFrame(opened, NODE_COMPRESSED_FRAME_CODEC), {
        kind: 'text',
        text
      })
    }
  }
  if (legacy) {
    assert(
      wireSizes.every((size) => size <= MOBILE_WEB_CATALOG_LEGACY_MAX_SEALED_BYTES),
      'legacy sealed catalog reply exceeds 1 MiB'
    )
  }
  const frameSizes: number[] = []
  const assemble = new BridgeReplyAssembler()
  let assembled: unknown
  createBridgeHostReplySender(
    (json) => {
      const size = Buffer.byteLength(json)
      assert(size <= BRIDGE_MAX_MESSAGE_BYTES)
      frameSizes.push(size)
      const parsed = readBridgeHostMessage(json)
      assert(parsed.ok && parsed.message.type === 'reply')
      const next = assemble.accept(parsed.message)
      assert.notEqual(next.status, 'failed')
      if (next.status === 'complete') {
        assembled = next.payload
      }
    },
    (_id, error) => {
      throw error
    }
  )(BRIDGE_ID, reply)
  assert.deepEqual(assembled, reply)
  return { wireSizes, frameSizes }
}

export function verifyMobileWebCatalogTransport(
  dir: string,
  entries: readonly MobileWebBundleCatalog[]
) {
  const read = (path: string) => readFileSync(join(dir, path))
  const disabled = process.env.ORCA_DISABLE_MOBILE_COMPRESSED_FRAMES
  delete process.env.ORCA_DISABLE_MOBILE_COMPRESSED_FRAMES
  try {
    for (const transport of ['direct', 'relay'] as const) {
      const wire = createWire(transport)
      for (const entry of entries) {
        assert.notEqual(entry.locale, 'en')
        const catalog: Record<string, unknown> = JSON.parse(read(entry.path).toString('utf8'))
        const legacy = identityCatalogResult(entry, catalog)
        const selected = entry.gzip
          ? gzipCatalogResult(entry, entry.gzip, read(entry.gzip.path).toString('base64'))
          : legacy
        if ('encoding' in selected) {
          assert.deepEqual(decodePageCatalogGzip(selected, inflateCatalogGzip), catalog)
        }
        const resultBytes = Buffer.byteLength(JSON.stringify(selected))
        assert(resultBytes <= MOBILE_WEB_CATALOG_MAX_RESULT_BYTES)
        const modernFrames = verifyReply(wire, selected, false)
        const legacyFrames = verifyReply(wire, legacy, true)
        verifyReply(wire, identityCatalogResult(entry, null), true)
        if (transport === 'relay') {
          console.log(
            `[mobile-catalog] ${entry.locale} ${resultBytes} result bytes, sealed modern ${modernFrames.wireSizes.join('/')} and legacy ${legacyFrames.wireSizes.join('/')} bytes (off/on)`
          )
        }
      }
      const entry = { locale: 'ru', sha256: '0'.repeat(64) }
      const chunked = identityCatalogResult(entry, { text: 'Я"🪴'.repeat(87_500) })
      const legacyFrames = verifyReply(wire, chunked, true)
      assert(legacyFrames.frameSizes.length > 1, 'oversized bridge reply must use parts')
      assert(
        legacyFrames.wireSizes[1]! < legacyFrames.wireSizes[0]!,
        'binary compression did not run'
      )
      const empty = JSON.stringify(
        successResponse(
          wire.id,
          { runtimeId: RUNTIME_ID },
          identityCatalogResult(entry, { text: '' })
        )
      )
      const emptySealed = Buffer.from(wire.desktop.sealText(empty), 'base64')
      assert.equal(wire.phone.openText(emptySealed.toString('base64')), empty)
      const available = (MOBILE_WEB_CATALOG_LEGACY_MAX_SEALED_BYTES * 3) / 4 - emptySealed.length
      const boundary = (extra: number) =>
        identityCatalogResult(entry, { text: 'a'.repeat(available + extra) })
      assert.equal(
        verifyReply(wire, boundary(0), true).wireSizes[0],
        MOBILE_WEB_CATALOG_LEGACY_MAX_SEALED_BYTES
      )
      assert.throws(() => verifyReply(wire, boundary(1), true), /legacy sealed catalog reply/)
    }
  } finally {
    if (disabled !== undefined) {
      process.env.ORCA_DISABLE_MOBILE_COMPRESSED_FRAMES = disabled
    }
  }
}
