const { existsSync } = require('node:fs')
const { join } = require('node:path')

// Build switches. A dark switch compiles its path in only when its variable is 'main'; a switch the
// desktop ships on compiles it in unless its variable is 'window', which builds the rollback
// variant. Either non-shipped desktop build leaves the switch's marker in out/main (a dark one also
// in the phone page bundle, out/mobile-web), and packaging refuses the marker and the variable.
const BUILD_SWITCHES = [
  // src/shared/layout-owner-switch.ts. The orcad server keeps it dark: paired servers stay mirrored.
  { variable: 'ORCA_LAYOUT_OWNER', off: 'window', desktopShipsOn: true },
  // src/shared/sidebar-inputs-switch.ts
  { variable: 'ORCA_SIDEBAR_INPUTS', off: 'window' }
]
const DARK_BUILD_SWITCHES = BUILD_SWITCHES.filter((buildSwitch) => !buildSwitch.desktopShipsOn)

const shipped = (buildSwitch) => (buildSwitch.desktopShipsOn ? 'main' : buildSwitch.off)
const unshipped = (buildSwitch) => (buildSwitch.desktopShipsOn ? buildSwitch.off : 'main')

function desktopValue(buildSwitch, env) {
  const asked = env[buildSwitch.variable]
  // A typo must not silently build what releases ship: only the two values mean anything.
  if (buildSwitch.desktopShipsOn && asked && asked !== 'main' && asked !== buildSwitch.off) {
    throw new Error(`${buildSwitch.variable}=${asked}: use main or ${buildSwitch.off}.`)
  }
  return asked === unshipped(buildSwitch) ? unshipped(buildSwitch) : shipped(buildSwitch)
}

/** Switches the desktop is built with away from what releases ship. */
function unshippedDesktop(env) {
  return BUILD_SWITCHES.filter(
    (buildSwitch) => desktopValue(buildSwitch, env) !== shipped(buildSwitch)
  )
}

function turnedOn(env) {
  return BUILD_SWITCHES.filter((buildSwitch) => env[buildSwitch.variable] === 'main')
}

/** The marker naming a switch's non-shipped value. */
function marker(buildSwitch) {
  const value = unshipped(buildSwitch)
  return {
    fileName: `${buildSwitch.variable}_${value.toUpperCase()}`,
    text: buildSwitch.desktopShipsOn
      ? `Built with ${buildSwitch.variable}=${value}, the rollback variant, for testing only.\n`
      : `Built with ${buildSwitch.variable}=${value}, for dark testing only.\n`
  }
}

/** Every switch's desktop define, so main and the window always compile the same value. */
function desktopBuildDefines(env = process.env) {
  return Object.fromEntries(
    BUILD_SWITCHES.map((buildSwitch) => [
      buildSwitch.variable,
      JSON.stringify(desktopValue(buildSwitch, env))
    ])
  )
}

/** What the desktop ships, whatever the environment asks: the unit tests' defines. */
function shippedDesktopDefines() {
  return Object.fromEntries(
    BUILD_SWITCHES.filter((buildSwitch) => buildSwitch.desktopShipsOn).map((buildSwitch) => [
      buildSwitch.variable,
      JSON.stringify('main')
    ])
  )
}

/** Only the switches asked for: an undeclared switch already reads as off (orcad, phone page). */
function turnedOnDarkBuildDefines(env = process.env) {
  return Object.fromEntries(
    turnedOn(env).map((buildSwitch) => [buildSwitch.variable, JSON.stringify('main')])
  )
}

/** Every marker a dark build can leave in the phone page bundle, so its check accounts for them. */
function darkBuildMarkerFileNames() {
  return DARK_BUILD_SWITCHES.map((buildSwitch) => marker(buildSwitch).fileName)
}

/** The marker each non-shipped desktop build leaves in out/main. */
function desktopBuildMarkers(env = process.env) {
  return unshippedDesktop(env).map(marker)
}

/** The marker each switched-on dark build leaves in the phone page bundle. */
function darkBuildMarkers(env = process.env) {
  const on = turnedOn(env)
  return DARK_BUILD_SWITCHES.filter((buildSwitch) => on.includes(buildSwitch)).map(marker)
}

function assertUnmarked(outputDirs, switches) {
  for (const buildSwitch of switches) {
    const { fileName } = marker(buildSwitch)
    const marked = outputDirs.find((dir) => existsSync(join(dir, fileName)))
    if (marked) {
      throw new Error(
        `${marked} holds an ${buildSwitch.variable}=${unshipped(buildSwitch)} build; rebuild it without that variable first.`
      )
    }
  }
}

/** Packaging: the desktop must be what releases ship, and so must every output it bundles. */
function assertReleaseDesktopBuild(outputDirs, env = process.env) {
  const [asked] = unshippedDesktop(env)
  if (asked) {
    throw new Error(
      asked.desktopShipsOn
        ? `${asked.variable}=${asked.off} builds the rollback variant for testing; unset it to package a release.`
        : `${asked.variable}=main is for dark test builds; unset it to package a release.`
    )
  }
  assertUnmarked(outputDirs, BUILD_SWITCHES)
}

/** The orcad template: every switch is dark on the server, so any 'main' is a test build. */
function assertNotDarkBuild(outputDirs, env = process.env) {
  const [asked] = turnedOn(env)
  if (asked) {
    throw new Error(
      `${asked.variable}=main is for dark test builds; unset it to package a release.`
    )
  }
  assertUnmarked(outputDirs, BUILD_SWITCHES)
}

/** For a build that may itself be dark: refuses only outputs marked by a switch this build has off. */
function assertNoDarkOutputOfOffSwitches(outputDirs, env = process.env) {
  const on = turnedOn(env)
  assertUnmarked(
    outputDirs,
    DARK_BUILD_SWITCHES.filter((buildSwitch) => !on.includes(buildSwitch))
  )
}

module.exports = {
  assertNoDarkOutputOfOffSwitches,
  assertNotDarkBuild,
  assertReleaseDesktopBuild,
  darkBuildMarkerFileNames,
  darkBuildMarkers,
  desktopBuildDefines,
  desktopBuildMarkers,
  shippedDesktopDefines,
  turnedOnDarkBuildDefines
}
