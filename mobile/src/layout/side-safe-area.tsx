import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  SafeAreaProvider,
  useSafeAreaFrame,
  useSafeAreaInsets,
  type EdgeInsets
} from 'react-native-safe-area-context'
import { SideRailProvider, sideRailEdge } from './side-rail'

const WindowSafeAreaInsetsContext = createContext<EdgeInsets | null>(null)
const SideRailReleaseContext = createContext<Dispatch<SetStateAction<number>> | null>(null)

// Pad side cutouts/navigation bars once, then expose the padded frame and insets so descendants neither pad twice nor size past it.
// Nesting one is safe: it pads only what an outer one left unpadded.
export function SideSafeArea({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets()
  const frame = useSafeAreaFrame()
  const [releases, setReleases] = useState(0)
  const railEdge = sideRailEdge(insets)
  const released = releases > 0 ? railEdge : null
  const left = released === 'left' ? 0 : insets.left
  const right = released === 'right' ? 0 : insets.right
  const areaInsets = useMemo(
    () => ({ ...insets, left: insets.left - left, right: insets.right - right }),
    [insets, left, right]
  )
  const areaFrame = useMemo(
    () => ({ ...frame, x: frame.x + left, width: Math.max(0, frame.width - left - right) }),
    [frame, left, right]
  )
  const area = (
    <WindowSafeAreaInsetsContext.Provider value={insets}>
      <SafeAreaFrameContext.Provider value={areaFrame}>
        <SafeAreaInsetsContext.Provider value={areaInsets}>
          <SideRailReleaseContext.Provider value={setReleases}>
            {children}
          </SideRailReleaseContext.Provider>
        </SafeAreaInsetsContext.Provider>
      </SafeAreaFrameContext.Provider>
    </WindowSafeAreaInsetsContext.Provider>
  )
  // Native SafeAreaView measures its nearest native provider, so nest one inside the padding; web reads the adjusted context.
  return (
    <View style={[styles.area, { paddingLeft: left, paddingRight: right }]}>
      <SideRailProvider
        edge={released ? null : railEdge}
        width={railEdge ? insets[railEdge] : 0}
        bottom={insets.bottom}
      >
        {Platform.OS === 'web' ? area : <SafeAreaProvider>{area}</SafeAreaProvider>}
      </SideRailProvider>
    </View>
  )
}

// A layout whose screens reach the Duo's status-bar rail themselves keeps it unpadded while mounted.
// Pages then get the rail's width as an inset and draw in it; native views beneath wrap themselves in SideSafeArea.
export function useReleasedSideRail(release: boolean): void {
  const setReleases = useContext(SideRailReleaseContext)
  useEffect(() => {
    if (!release || setReleases === null) {
      return
    }
    setReleases((count) => count + 1)
    return () => setReleases((count) => count - 1)
  }, [release, setReleases])
}

// Modals own a separate window outside SideSafeArea and need the original window insets.
export function useWindowSafeAreaInsets(): EdgeInsets {
  const insets = useSafeAreaInsets()
  return useContext(WindowSafeAreaInsetsContext) ?? insets
}

const styles = StyleSheet.create({
  area: { flex: 1 }
})
