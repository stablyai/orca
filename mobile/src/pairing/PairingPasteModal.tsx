import { TextInputModal } from '../components/sheets/TextInputModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function PairingPasteModal({
  visible,
  onSubmit,
  onCancel
}: {
  visible: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const t = useMobileTranslation()
  return (
    <TextInputModal
      visible={visible}
      title={t('app.pairScan.pasteCodeTitle', 'Paste pairing code')}
      message={t(
        'app.pairScan.pasteCodeMessage',
        'Copy the code shown under the QR on your computer.'
      )}
      placeholder={t('app.pairScan.pasteCodePlaceholder', 'orca://pair?code=... or paste the code')}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  )
}
