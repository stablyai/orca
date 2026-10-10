import { StyleSheet, Text, View } from 'react-native'
import { Laptop } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'

// Why: monochrome monograms keep the cabinet on the graphite palette (colour signals state only)
// while each provider still reads at a glance; brand marks would need per-vendor colours.
const PROVIDER_MONOGRAMS: Readonly<Record<string, string>> = {
  soniox: 'S',
  elevenlabs: 'II',
  deepgram: 'D',
  gemini: 'G',
  openai: 'AI',
  groq: 'gq',
  mistral: 'M'
}

function monogramFor(providerId: string): string {
  return PROVIDER_MONOGRAMS[providerId] ?? (providerId.charAt(0).toUpperCase() || '?')
}

type Props = {
  providerId: string
  size?: number
}

export function SpeechProviderLogo({ providerId, size = 32 }: Props) {
  const frame = { width: size, height: size, borderRadius: Math.round(size * 0.28) }
  if (providerId === 'local') {
    return (
      <View style={[styles.tile, frame]} testID="speech-provider-logo-local">
        <Laptop size={Math.round(size * 0.52)} color={colors.textPrimary} strokeWidth={1.9} />
      </View>
    )
  }
  const monogram = monogramFor(providerId)
  return (
    <View style={[styles.tile, frame]} testID={`speech-provider-logo-${providerId}`}>
      <Text
        style={[
          styles.monogram,
          { fontSize: Math.round(size * (monogram.length > 1 ? 0.36 : 0.44)) }
        ]}
        allowFontScaling={false}
      >
        {monogram}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  monogram: {
    color: colors.textPrimary,
    fontWeight: '700',
    letterSpacing: -0.3
  }
})
