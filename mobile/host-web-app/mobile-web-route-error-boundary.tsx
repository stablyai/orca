import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { mobileWebRouteFailureCode } from '../src/mobile-web/mobile-web-route-failure-code'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'

type MobileWebRouteErrorBoundaryProps = {
  children: ReactNode
  resetKey: string
}

type MobileWebRouteErrorBoundaryState = {
  failureCode: string | null
  resetKey: string
}

export class MobileWebRouteErrorBoundary extends Component<
  MobileWebRouteErrorBoundaryProps,
  MobileWebRouteErrorBoundaryState
> {
  state: MobileWebRouteErrorBoundaryState = {
    failureCode: null,
    resetKey: this.props.resetKey
  }

  static getDerivedStateFromProps(
    props: MobileWebRouteErrorBoundaryProps,
    state: MobileWebRouteErrorBoundaryState
  ): MobileWebRouteErrorBoundaryState | null {
    return props.resetKey === state.resetKey
      ? null
      : { failureCode: null, resetKey: props.resetKey }
  }

  static getDerivedStateFromError(
    error: unknown
  ): Pick<MobileWebRouteErrorBoundaryState, 'failureCode'> {
    return {
      failureCode: mobileWebRouteFailureCode(error)
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event('orca-mobile-web-route-failure'))
    }
    console.error('[mobile-web] hosted route stopped', {
      code: mobileWebRouteFailureCode(error),
      componentDepth: info.componentStack?.split('\n').length ?? 0
    })
  }

  render() {
    if (!this.state.failureCode) {
      return this.props.children
    }
    return (
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.title}>
          Workspace view stopped
        </Text>
        <Text
          accessibilityLabel={`Workspace view stopped. Reload the desktop-served interface to reconnect. Diagnostic: ${this.state.failureCode}`}
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
          style={styles.message}
        >
          Reload the desktop-served interface to reconnect. Diagnostic: {this.state.failureCode}
        </Text>
        <Pressable
          accessibilityLabel="Reload interface"
          accessibilityRole="button"
          style={styles.button}
          onPress={reloadMobileWebRoot}
        >
          <Text style={styles.buttonText}>Reload interface</Text>
        </Pressable>
      </View>
    )
  }
}

function reloadMobileWebRoot(): void {
  if (typeof window === 'undefined') {
    return
  }
  window.history.replaceState(window.history.state, '', '/')
  window.location.reload()
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: colors.bgBase
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700'
  },
  message: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    textAlign: 'center'
  },
  button: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  buttonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
