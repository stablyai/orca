import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  useMemo,
  type ReactNode
} from 'react'
import {
  Platform,
  Text,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextProps,
  type TextStyle
} from 'react-native'
import OrcaSelectableTextNativeComponent from './OrcaSelectableTextNativeComponent'
import OrcaSelectableTextRunNativeComponent from './OrcaSelectableTextRunNativeComponent'
import { inheritTextStyle, toRunStyle } from './run-style'

/** `start === end` means the selection was cleared. Offsets are UTF-16 indices. */
export type SelectionChangeEvent = NativeSyntheticEvent<{
  target: number
  start: number
  end: number
}>

export type SelectableTextProps = Omit<
  TextProps,
  'onPress' | 'onLongPress' | 'onTextLayout' | 'style' | 'numberOfLines' | 'ellipsizeMode'
> & {
  style?: StyleProp<TextStyle>
  onPress?: () => void
  onSelectionChange?: (event: SelectionChangeEvent) => void
}

/** Indents and spacing for every paragraph a run of this text falls in, in points. */
export type SelectableTextParagraphStyle = {
  firstLineHeadIndent?: number
  headIndent?: number
  spacing?: number
}

// Set inside a native root: nested text becomes runs of that one view.
const InheritedStyleContext = createContext<TextStyle | null>(null)
const ParagraphStyleContext = createContext<SelectableTextParagraphStyle | null>(null)

type RunsProps = {
  children: ReactNode
  style: TextStyle
  onPress?: () => void
}

// Fragments would put bare strings under the native view, so lift their children.
// Children.map prefixes each lifted child's key with its fragment's, keeping keys unique.
function flattenFragments(children: ReactNode): ReactNode[] {
  return (
    Children.map(children, (child) =>
      isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
        ? flattenFragments(child.props.children)
        : child
    ) ?? []
  )
}

// Each run is a shadow node, so adjacent plain strings share one.
function joinAdjacentText(children: ReactNode[]): ReactNode[] {
  const joined: ReactNode[] = []
  for (const child of children) {
    const text = typeof child === 'string' || typeof child === 'number' ? String(child) : null
    const previous = joined.at(-1)
    if (text !== null && typeof previous === 'string') {
      joined[joined.length - 1] = previous + text
    } else {
      joined.push(text ?? child)
    }
  }
  return joined
}

function Runs({ children, style, onPress }: RunsProps): ReactNode {
  const paragraph = useContext(ParagraphStyleContext)
  const runStyle = useMemo(() => toRunStyle(style), [style])
  const runs = joinAdjacentText(flattenFragments(children)).map((child, index) => {
    if (isValidElement(child)) {
      return child
    }
    if (typeof child !== 'string' && typeof child !== 'number') {
      return null
    }
    return (
      <OrcaSelectableTextRunNativeComponent
        key={index}
        style={runStyle}
        text={String(child)}
        paragraphFirstLineHeadIndent={paragraph?.firstLineHeadIndent}
        paragraphHeadIndent={paragraph?.headIndent}
        paragraphSpacing={paragraph?.spacing}
        onPress={onPress ? () => onPress() : undefined}
      />
    )
  })
  return <InheritedStyleContext.Provider value={style}>{runs}</InheritedStyleContext.Provider>
}

function NestedText({
  parentStyle,
  style,
  children,
  onPress
}: SelectableTextProps & { parentStyle: TextStyle }): ReactNode {
  const inherited = useMemo(() => inheritTextStyle(parentStyle, style), [parentStyle, style])
  return (
    <Runs style={inherited} onPress={onPress}>
      {children}
    </Runs>
  )
}

export function SelectableText(props: SelectableTextProps): ReactNode {
  const parentStyle = useContext(InheritedStyleContext)
  const { style, children, onPress, onSelectionChange, ...rest } = props
  const rootStyle = useMemo(() => inheritTextStyle({}, style), [style])
  if (parentStyle) {
    return <NestedText {...props} parentStyle={parentStyle} />
  }
  // Only opted-in selectable text pays for a UITextView.
  if (Platform.OS !== 'ios' || rest.selectable !== true) {
    return (
      <Text {...rest} style={style} onPress={onPress}>
        {children}
      </Text>
    )
  }
  return (
    <OrcaSelectableTextNativeComponent
      {...rest}
      style={toRunStyle(rootStyle)}
      onSelectionChange={onSelectionChange}
    >
      <Runs style={rootStyle} onPress={onPress}>
        {children}
      </Runs>
    </OrcaSelectableTextNativeComponent>
  )
}

/** Gives every run inside it one paragraph layout; use only inside a `SelectableText`. */
export function SelectableTextParagraph({
  paragraph,
  style,
  children
}: {
  paragraph: SelectableTextParagraphStyle
  style?: StyleProp<TextStyle>
  children: ReactNode
}): ReactNode {
  const parentStyle = useContext(InheritedStyleContext) ?? {}
  return (
    <ParagraphStyleContext.Provider value={paragraph}>
      <NestedText parentStyle={parentStyle} style={style}>
        {children}
      </NestedText>
    </ParagraphStyleContext.Provider>
  )
}
