import type { ReactElement } from 'react'
import Svg, { Path, type PathProps, type SvgProps } from 'react-native-svg'

/** A string is a path drawn with the default stroke; an object overrides it for one layer. */
export type MobileIconLayer = string | Readonly<PathProps & { d: string }>

export type MobileIconProps = Omit<
  SvgProps,
  'width' | 'height' | 'viewBox' | 'stroke' | 'strokeWidth'
> & {
  size?: number
  color?: string
}

export type MobileIcon = (props: MobileIconProps) => ReactElement

// Hugeicons are drawn on a 24 px grid for a 1.5 stroke; one weight keeps every screen consistent.
const STROKE = {
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export function mobileIcon(...layers: MobileIconLayer[]): MobileIcon {
  const paths = layers.map((layer) => (typeof layer === 'string' ? { d: layer } : layer))
  return function Icon({ size = 24, color, fill = 'none', children, ...rest }: MobileIconProps) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" color={color} fill="none" {...rest}>
        {paths.map((path) => (
          <Path key={path.d} {...STROKE} fill={fill} {...path} />
        ))}
        {children}
      </Svg>
    )
  }
}
