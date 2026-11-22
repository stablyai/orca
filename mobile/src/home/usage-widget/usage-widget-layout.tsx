import { HStack, Image, ProgressView, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui'
import {
  background,
  clipShape,
  containerBackground,
  font,
  foregroundStyle,
  fixedSize,
  frame,
  lineLimit,
  minimumScaleFactor,
  monospacedDigit,
  opacity,
  progressViewStyle,
  resizable,
  tint,
  widgetURL
} from '@expo/ui/swift-ui/modifiers'
import { createWidget, type WidgetEnvironment } from 'expo-widgets'
import type {
  UsageWidgetAgent,
  UsageWidgetConfiguration,
  UsageWidgetMeter,
  UsageWidgetProps
} from './usage-widget-timeline'

// The 'widget' directive turns this into a string the widget extension evaluates: it may only use
// @expo/ui components and modifiers, so everything else arrives precomputed in props.
function UsageWidgetLayout(
  props: UsageWidgetProps | undefined,
  environment: WidgetEnvironment<UsageWidgetConfiguration>
) {
  'widget'
  // English only: without saved props there is no translated copy to show.
  const FALLBACK_NOTE = 'Open Orca to load usage'
  const fill = frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' })
  // Before the app's first write or after a props change (USAGE_WIDGET_PROPS_VERSION), a plain note
  // instead of an error; a widget without a URL opens the app when tapped.
  const note = (text: string | undefined, modifiers: ReturnType<typeof frame>[]) => (
    <VStack alignment="leading" spacing={6} modifiers={[...modifiers, fill]}>
      <Image systemName="gauge.with.dots.needle.33percent" size={20} />
      <Text
        modifiers={[
          font({ textStyle: 'subheadline' }),
          foregroundStyle({ type: 'hierarchical', style: 'secondary' })
        ]}
      >
        {text ?? FALLBACK_NOTE}
      </Text>
    </VStack>
  )
  const blank = [containerBackground({ type: 'material', material: 'regular' }, 'widget')]
  if (props?.v !== 3) {
    return note(props?.labels?.empty, blank)
  }
  // A damaged save of the right version still must not show an error in place of the widget.
  try {
    return draw(props)
  } catch {
    return note(undefined, blank)
  }

  function draw(props: UsageWidgetProps) {
    const { labels } = props
    const scheme = environment.colorScheme === 'light' ? 'light' : 'dark'
    const palette = props.palettes[scheme]
    const family = environment.widgetFamily ?? 'systemMedium'
    const small = family === 'systemSmall'
    const large = family === 'systemLarge'
    const configuration: UsageWidgetConfiguration = environment.configuration ?? {}
    const root = [containerBackground(palette.background, 'widget'), widgetURL(props.url)]

    // Automatic, or a desktop since unpaired: the one updated most recently.
    const host = props.hosts.find((entry) => entry.id === configuration.desktop) ?? props.hosts[0]
    if (!host) {
      return note(labels.empty, root)
    }

    const choice = configuration.window ?? 'automatic'
    const windows: ('session' | 'weekly' | 'either')[] =
      choice === 'session'
        ? ['session']
        : choice === 'weekly'
          ? ['weekly']
          : choice === 'both' || !small
            ? ['session', 'weekly']
            : ['either']

    const limit = small ? 2 : large ? 6 : 3
    // "Choose" uses the rows in order, each agent once; "none" and agents no longer reported are skipped.
    const picked =
      configuration.agentMode === 'custom'
        ? (configuration.agents ?? []).flatMap((id, index, rows) =>
            rows.indexOf(id) === index ? host.agents.filter((agent) => agent.id === id) : []
          )
        : []
    // Otherwise the most used that fit, in the app's order so the layout doesn't reshuffle.
    const top = [...host.agents].sort((left, right) => right.peak - left.peak).slice(0, limit)
    const agents =
      picked.length > 0 ? picked.slice(0, limit) : host.agents.filter((a) => top.includes(a))

    const meterOf = (agent: UsageWidgetAgent, kind: 'session' | 'weekly' | 'either') =>
      kind === 'either' ? (agent.session ?? agent.weekly) : agent[kind]
    // The window a row shows, so a lone percentage can still say whether it is 5h or 7d.
    const kindOf = (agent: UsageWidgetAgent, kind: 'session' | 'weekly' | 'either') =>
      kind !== 'either' ? kind : agent.session ? 'session' : agent.weekly ? 'weekly' : null

    const caption = (text: string) => (
      <Text
        modifiers={[
          font({ textStyle: 'caption2' }),
          foregroundStyle(palette.secondary),
          lineLimit(1)
        ]}
      >
        {text}
      </Text>
    )
    const updated = (
      <Text
        modifiers={[
          font({ textStyle: 'caption2' }),
          foregroundStyle(palette.secondary),
          lineLimit(1),
          fixedSize({ horizontal: true, vertical: false })
        ]}
      >
        {host.updated}
      </Text>
    )
    const value = (meter: UsageWidgetMeter | undefined, textStyle: 'caption' | 'subheadline') => (
      <Text
        modifiers={[
          font({ textStyle, weight: 'semibold' }),
          monospacedDigit(),
          foregroundStyle(palette.primary)
        ]}
      >
        {meter?.value ?? '—'}
      </Text>
    )
    const bar = (meter: UsageWidgetMeter | undefined) => (
      <ProgressView
        value={meter?.fill ?? 0}
        modifiers={[progressViewStyle('linear'), tint(meter ? meter.color[scheme] : palette.track)]}
      />
    )
    const agentLabel = (agent: UsageWidgetAgent, size: number, strong: boolean) => (
      <HStack spacing={4}>
        {/* As MobileAgentIcon draws them: the mark with radii.mark corners (4 of 16), else a letter tile. */}
        {agent.icon ? (
          <Image
            uiImage={agent.icon[scheme]}
            modifiers={[
              resizable(),
              frame({ width: size, height: size }),
              clipShape('roundedRectangle', size / 4)
            ]}
          />
        ) : (
          <ZStack
            modifiers={[
              frame({ width: size, height: size }),
              background(palette.letterTile),
              clipShape('roundedRectangle', size / 4)
            ]}
          >
            <Text
              modifiers={[
                font({ size: size * 0.55, weight: 'bold' }),
                foregroundStyle(palette.primary)
              ]}
            >
              {agent.title.slice(0, 1).toUpperCase()}
            </Text>
          </ZStack>
        )}
        <Text
          modifiers={[
            font(
              strong ? { textStyle: 'subheadline', weight: 'semibold' } : { textStyle: 'caption' }
            ),
            foregroundStyle(strong ? palette.primary : palette.secondary),
            lineLimit(1)
          ]}
        >
          {agent.title}
        </Text>
      </HStack>
    )
    // A window's label and value over its bar, and on medium and large its reset countdown.
    const windowMeter = (agent: UsageWidgetAgent, kind: 'session' | 'weekly' | 'either') => {
      const meter = meterOf(agent, kind)
      return (
        <VStack
          alignment="leading"
          spacing={2}
          modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
        >
          <HStack alignment="firstTextBaseline">
            {caption(kind === 'session' ? labels.session : kind === 'weekly' ? labels.weekly : '')}
            <Spacer minLength={2} />
            {value(meter, 'caption')}
          </HStack>
          {bar(meter)}
          {!small && meter?.resets ? (
            <Text
              modifiers={[
                font({ textStyle: 'caption2' }),
                foregroundStyle(palette.secondary),
                lineLimit(1),
                minimumScaleFactor(0.75)
              ]}
            >
              {meter.resets}
            </Text>
          ) : null}
        </VStack>
      )
    }

    let body
    const rowKinds = agents.map((agent) => kindOf(agent, windows[0] ?? 'either'))
    // One window for every row is named once in the header; mixed windows are named on each row.
    const sharedKind = rowKinds.every((kind) => kind === rowKinds[0]) ? rowKinds[0] : null
    const windowLabel = (kind: 'session' | 'weekly' | null | undefined) =>
      kind === 'session' ? labels.session : kind === 'weekly' ? labels.weekly : null
    const headerLabel = small && windows.length === 1 ? windowLabel(sharedKind) : null
    if (small && windows.length === 1) {
      body = agents.map((agent, index) => (
        <VStack key={agent.id} alignment="leading" spacing={3}>
          <HStack alignment="firstTextBaseline">
            {agentLabel(agent, 12, false)}
            <Spacer minLength={4} />
            {sharedKind ? null : caption(windowLabel(rowKinds[index]) ?? '')}
            {value(meterOf(agent, windows[0]), 'subheadline')}
          </HStack>
          {bar(meterOf(agent, windows[0]))}
        </VStack>
      ))
    } else if (small) {
      body = agents.map((agent) => (
        <VStack key={agent.id} alignment="leading" spacing={3}>
          {agentLabel(agent, 12, false)}
          <HStack alignment="top" spacing={8}>
            {windows.map((kind) => windowMeter(agent, kind))}
          </HStack>
        </VStack>
      ))
    } else if (large) {
      // One name column for every row, only as wide as the longest name shown (icon, gap and about
      // 8.5pt per subheadline character), so the meters keep room for their full reset line.
      const nameWidth = Math.min(
        104,
        Math.ceil(18 + 8.5 * Math.max(0, ...agents.map((a) => a.title.length)))
      )
      body = agents.map((agent) => (
        <HStack key={agent.id} alignment="top" spacing={8}>
          <HStack modifiers={[frame({ width: nameWidth, alignment: 'leading' })]}>
            {agentLabel(agent, 14, true)}
          </HStack>
          {windows.map((kind) => windowMeter(agent, kind))}
        </HStack>
      ))
    } else {
      body = (
        <HStack alignment="top" spacing={14}>
          {agents.map((agent) => (
            <VStack
              key={agent.id}
              alignment="leading"
              spacing={6}
              modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
            >
              {agentLabel(agent, 14, true)}
              {windows.map((kind) => windowMeter(agent, kind))}
            </VStack>
          ))}
        </HStack>
      )
    }

    return (
      <VStack
        alignment="leading"
        spacing={small ? 6 : 8}
        modifiers={[...root, fill, opacity(host.stale ? 0.45 : 1)]}
      >
        <HStack spacing={6}>
          <Text
            modifiers={[
              font({ textStyle: 'caption', weight: 'semibold' }),
              foregroundStyle(palette.secondary),
              lineLimit(1)
            ]}
          >
            {host.name}
          </Text>
          <Spacer minLength={4} />
          {small ? (headerLabel ? caption(headerLabel) : null) : updated}
        </HStack>
        {body}
        <Spacer minLength={0} />
        {small ? updated : null}
      </VStack>
    )
  }
}

export const usageWidget = createWidget<UsageWidgetProps, UsageWidgetConfiguration>(
  'OrcaUsage',
  UsageWidgetLayout
)
