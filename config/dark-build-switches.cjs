const { existsSync } = require('node:fs')
const { join } = require('node:path')

// Dark build switches: a build compiles a switch's path in only when its variable is 'main'. Such a
// main build leaves the switch's marker in out/main, the phone page bundle (out/mobile-web), out/orcad
// and a --dark-test-template orcad template; packaging refuses any of them, and packaging and a
// release orcad template also refuse the variable itself.
const DARK_BUILD_SWITCHES = [
  // src/shared/layout-owner-switch.ts
  { variable: 'ORCA_LAYOUT_OWNER', off: 'window' },
  // src/shared/sidebar-inputs-switch.ts
  { variable: 'ORCA_SIDEBAR_INPUTS', off: 'window' }
]

function markerFileName(darkSwitch) {
  return `${darkSwitch.variable}_MAIN`
}

function turnedOn(env) {
  return DARK_BUILD_SWITCHES.filter((darkSwitch) => env[darkSwitch.variable] === 'main')
}

/** Every switch's define: 'main' only when asked, so other builds fold the branches away. */
function darkBuildDefines(env = process.env) {
  const on = turnedOn(env)
  return Object.fromEntries(
    DARK_BUILD_SWITCHES.map((darkSwitch) => [
      darkSwitch.variable,
      JSON.stringify(on.includes(darkSwitch) ? 'main' : darkSwitch.off)
    ])
  )
}

/** Only the switches asked for: an undeclared switch already reads as off. */
function turnedOnDarkBuildDefines(env = process.env) {
  return Object.fromEntries(
    turnedOn(env).map((darkSwitch) => [darkSwitch.variable, JSON.stringify('main')])
  )
}

/** Every marker a switched-on build can leave, so a bundle check accounts for them. */
function darkBuildMarkerFileNames() {
  return DARK_BUILD_SWITCHES.map(markerFileName)
}

/** The marker each switched-on build leaves in its output. */
function darkBuildMarkers(env = process.env) {
  return turnedOn(env).map((darkSwitch) => ({
    fileName: markerFileName(darkSwitch),
    text: `Built with ${darkSwitch.variable}=main, for dark testing only.\n`
  }))
}

function assertUnmarked(outputDirs, switches) {
  for (const darkSwitch of switches) {
    const marked = outputDirs.find((dir) => existsSync(join(dir, markerFileName(darkSwitch))))
    if (marked) {
      throw new Error(
        `${marked} holds an ${darkSwitch.variable}=main build; rebuild it without that variable first.`
      )
    }
  }
}

function assertNotDarkBuild(outputDirs, env = process.env) {
  const [asked] = turnedOn(env)
  if (asked) {
    throw new Error(
      `${asked.variable}=main is for dark test builds; unset it to package a release.`
    )
  }
  assertUnmarked(outputDirs, DARK_BUILD_SWITCHES)
}

/** For a build that may itself be dark: refuses only outputs marked by a switch this build has off. */
function assertNoDarkOutputOfOffSwitches(outputDirs, env = process.env) {
  const on = turnedOn(env)
  assertUnmarked(
    outputDirs,
    DARK_BUILD_SWITCHES.filter((darkSwitch) => !on.includes(darkSwitch))
  )
}

module.exports = {
  assertNoDarkOutputOfOffSwitches,
  assertNotDarkBuild,
  darkBuildDefines,
  darkBuildMarkerFileNames,
  darkBuildMarkers,
  turnedOnDarkBuildDefines
}
