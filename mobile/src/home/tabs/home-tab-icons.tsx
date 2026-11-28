// Bottom tab bar glyphs only: outline when idle, solid when active. Row avatars keep their own icons.
import Svg, { Ellipse, Path } from 'react-native-svg'
import type { HomeTabId } from './home-tabs'

export type HomeTabIconProps = { size: number; color: string; active: boolean }

const OUTLINE = {
  fill: 'none',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

function FeedIcon({ size, color, active }: HomeTabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {active ? (
        <Path
          fill={color}
          d="M5.625 3.75a2.625 2.625 0 1 0 0 5.25h12.75a2.625 2.625 0 0 0 0-5.25H5.625ZM3.75 11.25a.75.75 0 0 0 0 1.5h16.5a.75.75 0 0 0 0-1.5H3.75ZM3 15.75a.75.75 0 0 1 .75-.75h16.5a.75.75 0 0 1 0 1.5H3.75a.75.75 0 0 1-.75-.75ZM3.75 18.75a.75.75 0 0 0 0 1.5h16.5a.75.75 0 0 0 0-1.5H3.75Z"
        />
      ) : (
        <Path
          {...OUTLINE}
          stroke={color}
          d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z"
        />
      )}
    </Svg>
  )
}

// Why one evenodd path for the solid face: the eyes cut out without a mask id per instance.
const BOT_FACE = 'M40 128a88 88 0 1 0 176 0a88 88 0 1 0-176 0Z'
const BOT_EYES =
  'M83 122a11 15 0 1 0 22 0a11 15 0 1 0-22 0ZM151 122a11 15 0 1 0 22 0a11 15 0 1 0-22 0Z'

function BotsIcon({ size, color, active }: HomeTabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256">
      {active ? (
        <Path fill={color} fillRule="evenodd" d={BOT_FACE + BOT_EYES} />
      ) : (
        <>
          <Path d={BOT_FACE} fill="none" stroke={color} strokeWidth={16} />
          <Ellipse cx={94} cy={122} rx={11} ry={15} fill={color} />
          <Ellipse cx={162} cy={122} rx={11} ry={15} fill={color} />
        </>
      )}
    </Svg>
  )
}

function AgentsIcon({ size, color, active }: HomeTabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {active ? (
        <Path
          fill={color}
          fillRule="evenodd"
          clipRule="evenodd"
          d="M2.25 6a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5.25a3 3 0 0 1-3-3V6Zm3.97.97a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1 0 1.06l-2.25 2.25a.75.75 0 0 1-1.06-1.06l1.72-1.72-1.72-1.72a.75.75 0 0 1 0-1.06Zm4.28 4.28a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z"
        />
      ) : (
        <Path
          {...OUTLINE}
          stroke={color}
          d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      )}
    </Svg>
  )
}

function UsageIcon({ size, color, active }: HomeTabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256">
      <Path
        fill={color}
        d={
          active
            ? 'M240,152v24a16,16,0,0,1-16,16H115.93a4,4,0,0,1-3.24-6.35L174.27,101a8.21,8.21,0,0,0-1.37-11.3,8,8,0,0,0-11.37,1.61l-72,99.06A4,4,0,0,1,86.25,192H32a16,16,0,0,1-16-16V153.13c0-1.79,0-3.57.13-5.33a4,4,0,0,1,4-3.8H48a8,8,0,0,0,8-8.53A8.17,8.17,0,0,0,47.73,128H23.92a4,4,0,0,1-3.87-5c12-43.84,49.66-77.13,95.52-82.28a4,4,0,0,1,4.43,4V72a8,8,0,0,0,8.53,8A8.17,8.17,0,0,0,136,71.73V44.67a4,4,0,0,1,4.43-4A112.18,112.18,0,0,1,236.23,123a4,4,0,0,1-3.88,5H208.27a8.17,8.17,0,0,0-8.25,7.47,8,8,0,0,0,8,8.53h27.92a4,4,0,0,1,4,3.86C240,149.23,240,150.61,240,152Z'
            : 'M207.06,72.67A111.24,111.24,0,0,0,128,40h-.4C66.07,40.21,16,91,16,153.13V176a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V152A111.25,111.25,0,0,0,207.06,72.67ZM224,176H119.71l54.76-75.3a8,8,0,0,0-12.94-9.42L99.92,176H32V153.13c0-3.08.15-6.12.43-9.13H56a8,8,0,0,0,0-16H35.27c10.32-38.86,44-68.24,84.73-71.66V80a8,8,0,0,0,16,0V56.33A96.14,96.14,0,0,1,221,128H200a8,8,0,0,0,0,16h23.67c.21,2.65.33,5.31.33,8Z'
        }
      />
    </Svg>
  )
}

function AutomationsIcon({ size, color, active }: HomeTabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {active ? (
        <Path
          fill={color}
          fillRule="evenodd"
          clipRule="evenodd"
          d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z"
        />
      ) : (
        <Path
          {...OUTLINE}
          stroke={color}
          d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
        />
      )}
    </Svg>
  )
}

export const HOME_TAB_ICONS: Record<HomeTabId, (props: HomeTabIconProps) => React.JSX.Element> = {
  feed: FeedIcon,
  bots: BotsIcon,
  agents: AgentsIcon,
  usage: UsageIcon,
  automations: AutomationsIcon
}
