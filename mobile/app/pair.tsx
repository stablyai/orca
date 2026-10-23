import { useCallback, useEffect, useState } from 'react'
import { Linking } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { QrCode } from 'lucide-react-native'
import { extractPairingCodeFromUrl } from '../src/transport/pairing'
import { Button } from '../src/components/ui/Button'
import { PairingMessage, PairingScreenFrame } from '../src/pairing-screen-frame'

export default function PairRedirectScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ code?: string }>()
  const [missingCode, setMissingCode] = useState(false)

  const goHome = useCallback(() => {
    router.replace('/')
  }, [router])

  useEffect(() => {
    let disposed = false

    async function redirectToConfirm() {
      const codeParam = Array.isArray(params.code) ? params.code[0] : params.code
      if (codeParam) {
        router.replace({ pathname: '/pair-confirm', params: { code: codeParam } })
        return
      }

      const initialUrl = await Linking.getInitialURL().catch(() => null)
      const code = initialUrl ? extractPairingCodeFromUrl(initialUrl) : null
      if (disposed) {
        return
      }
      if (code) {
        router.replace({ pathname: '/pair-confirm', params: { code } })
        return
      }
      setMissingCode(true)
    }

    void redirectToConfirm()
    return () => {
      disposed = true
    }
  }, [params.code, router])

  return (
    <PairingScreenFrame
      title="Pair a desktop"
      onCancel={goHome}
      actions={
        missingCode ? (
          <Button label="Back to home" variant="primary" block onPress={goHome} />
        ) : undefined
      }
    >
      {missingCode ? (
        <PairingMessage
          icon={QrCode}
          title="No pairing code"
          message="This link didn't include a pairing code. Scan the QR code from Orca on your computer instead."
        />
      ) : (
        <PairingMessage loading title="Opening pairing link…" />
      )}
    </PairingScreenFrame>
  )
}
