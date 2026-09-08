export function pairingPublicKeyFromUrl(pairingUrl) {
  const offer = pairingOfferFromUrl(pairingUrl)
  if (typeof offer.publicKeyB64 !== 'string' || offer.publicKeyB64.length === 0) {
    throw new Error('E2E paired-host selection received an invalid public key.')
  }
  return offer.publicKeyB64
}

export function pairingEndpointPortFromUrl(pairingUrl) {
  const offer = pairingOfferFromUrl(pairingUrl)
  if (typeof offer.endpoint !== 'string' || offer.endpoint.length === 0) {
    throw new Error('E2E paired-host selection received an invalid endpoint.')
  }
  const endpoint = new URL(
    offer.endpoint.includes('://') ? offer.endpoint : `ws://${offer.endpoint}`
  )
  const port = Number(endpoint.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('E2E paired-host selection received an invalid endpoint port.')
  }
  return port
}

function pairingOfferFromUrl(pairingUrl) {
  if (!pairingUrl) {
    throw new Error('E2E paired-host selection requires a pairing URL.')
  }
  const code = new URL(pairingUrl).searchParams.get('code')
  if (!code) {
    throw new Error('E2E paired-host selection received an invalid pairing URL.')
  }
  const offer = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
  if (!offer || typeof offer !== 'object') {
    throw new Error('E2E paired-host selection received an invalid pairing offer.')
  }
  return offer
}
