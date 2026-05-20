import Svg, { Path } from 'react-native-svg'

export type TaskProviderLogoKind = 'github' | 'gitlab' | 'linear'

type Props = {
  provider: TaskProviderLogoKind
  size?: number
  color: string
}

export function TaskProviderLogo({ provider, size = 16, color }: Props) {
  if (provider === 'github') {
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Why: lucide-react-native omits deprecated brand icons; keep parity with desktop lucide paths. */}
        <Path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
        <Path d="M9 18c-4.51 2-5-2-7-2" />
      </Svg>
    )
  }

  if (provider === 'gitlab') {
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Why: lucide-react-native omits deprecated brand icons; keep parity with desktop lucide paths. */}
        <Path d="m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26A.42.42 0 0 0 6 3.08.38.38 0 0 0 5.74 3a.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z" />
      </Svg>
    )
  }

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      {/* Why: keep Linear's mobile glyph aligned with the desktop sidebar logo. */}
      <Path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </Svg>
  )
}
