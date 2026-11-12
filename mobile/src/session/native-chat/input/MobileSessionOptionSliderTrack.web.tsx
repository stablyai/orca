import { useState, type PointerEvent } from 'react'
import { colors, feedback, radii } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { MobileSessionOptionSliderTrackProps } from './MobileNativeChatSessionOptionSlider'

const THUMB = 20

export function MobileSessionOptionSliderTrack(
  props: MobileSessionOptionSliderTrackProps
): React.JSX.Element {
  useMobileColorScheme()
  const [preview, setPreview] = useState<number | null>(null)
  const shown = preview ?? props.value
  const clear = (): void => {
    setPreview(null)
    props.onPreview(null)
  }
  const indexAt = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = (event.clientX - rect.left - THUMB / 2) / Math.max(1, rect.width - THUMB)
    return Math.max(0, Math.min(props.count - 1, Math.round(fraction * (props.count - 1))))
  }
  return (
    <div
      role="slider"
      tabIndex={props.disabled ? -1 : 0}
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={props.count - 1}
      aria-valuenow={shown ?? undefined}
      aria-valuetext={props.valueText}
      aria-disabled={props.disabled}
      onPointerDown={(event) => {
        if (props.disabled || event.button !== 0) {
          return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.focus()
        const index = indexAt(event)
        setPreview(index)
        props.onPreview(index)
      }}
      onPointerMove={(event) => {
        if (props.disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) {
          return
        }
        const index = indexAt(event)
        setPreview(index)
        props.onPreview(index)
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
          return
        }
        event.currentTarget.releasePointerCapture(event.pointerId)
        clear()
        if (!props.disabled) {
          props.onCommit(indexAt(event))
        }
      }}
      onPointerCancel={clear}
      onKeyDown={(event) => {
        if (props.disabled) {
          return
        }
        const direction = ['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key)
          ? 1
          : ['ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key)
            ? -1
            : 0
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? props.count - 1
              : direction
                ? Math.max(
                    0,
                    Math.min(
                      props.count - 1,
                      (props.value ?? (direction > 0 ? -1 : props.count)) + direction
                    )
                  )
                : null
        if (next === null) {
          return
        }
        event.preventDefault()
        props.onCommit(next)
      }}
      onBlur={clear}
      style={{
        position: 'relative',
        height: 44,
        display: 'flex',
        alignItems: 'center',
        touchAction: 'none',
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? feedback.disabledOpacity : 1
      }}
    >
      <div
        style={{
          margin: '0 10px',
          width: 'calc(100% - 20px)',
          height: 4,
          borderRadius: radii.pill,
          background: colors.translucentFill
        }}
      >
        {shown === null ? null : (
          <div
            style={{
              width: `${(shown / (props.count - 1)) * 100}%`,
              height: '100%',
              borderRadius: radii.pill,
              background: colors.textPrimary
            }}
          />
        )}
      </div>
      {shown === null ? null : (
        <div
          style={{
            position: 'absolute',
            left: `calc(${(shown / (props.count - 1)) * 100}% + ${THUMB / 2 - (THUMB * shown) / (props.count - 1)}px)`,
            transform: 'translateX(-50%)',
            boxSizing: 'border-box',
            width: THUMB,
            height: THUMB,
            borderRadius: radii.pill,
            background: colors.sheetGroup,
            border: `1px solid ${colors.inputBorder}`,
            pointerEvents: 'none'
          }}
        />
      )}
    </div>
  )
}
