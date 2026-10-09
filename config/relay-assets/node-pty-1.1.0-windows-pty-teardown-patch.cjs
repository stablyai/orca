const { createHash } = require('node:crypto')
const { readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

/**
 * Release the ConPTY teardown handles a relay's npm-installed node-pty never releases.
 *
 * Two files, and the ORDER of one of the edits is the whole fix.
 *
 * `windowsPtyAgent.js` -- `kill()` flips `readable` on both sockets and destroys neither.
 * `_cleanUpProcess` destroys `_outSocket`, so the conout handle comes back; nothing ever destroys
 * `_inSocket`, and it wraps a real Windows named-pipe handle from `fs.openSync(term.conin, 'w')`.
 * Every terminal leaks one File handle for the life of the host process.
 *
 * The obvious fix -- and the placement `config/patches/node-pty@1.1.0.patch` uses -- releases it at
 * the TOP of the branch, before `_getConsoleProcessList()` forks and before the native kill. That is
 * measurably worse than leaving the leak alone: teardown aborts partway, the forked console-list
 * agent is never reaped, and both pipe handles stay alive instead of one. This asset releases it at
 * the END of the branch instead, after the fork and the kill have already happened.
 *
 * Measured on a Windows SSH host, 20 spawn/kill cycles, handles bucketed by NT object type
 * (identical numbers standalone and through a real relay). Every row is the NON-DLL branch, which
 * is the branch a relay runs -- see the divergence note below for why that matters:
 *
 *   published node-pty        File +1/terminal,  Process flat
 *   desktop patch placement   File +2/terminal,  Process +1/terminal   <-- 3x WORSE
 *   released last (here)      File flat,         Process flat
 *
 * `windowsTerminal.js` carries the desktop's error-listener hunks verbatim. The conin listener is
 * what keeps a pipe error retiring one terminal instead of the host -- its own comment names the
 * failure mode: "Without a listener, Node promotes errors such as write EAGAIN to uncaughtException".
 * It is not what fixes the leak (adding it changed nothing on its own), but it is the guard that
 * makes destroying conin safe at all.
 *
 * Why this ships as a relay asset rather than only in config/patches/node-pty@1.1.0.patch: pnpm
 * patches do not cross the SSH boundary -- a relay host runs the tree `npm install` put there.
 *
 * DELIBERATE DIVERGENCE FROM THE DESKTOP, AND WHY IT IS NOT A DESKTOP-TERMINAL BUG: the two hosts
 * do not run the same branch of `kill()`. node-pty defaults `_useConptyDll` to false
 * (`windowsPtyAgent.js`). Every desktop site that opens a terminal pane sets it true --
 * `local-pty-utils.ts` (two) and `native-pty-spawn.ts` -- as does the `windows-conpty-warmup.ts`
 * warm-up, so all of those take the `else` branch, where UPSTREAM ALREADY destroys the input
 * socket. The relay passes no such option (`src/relay/pty-handler.ts`), so it takes the
 * `!useConptyDll` branch -- the one this asset and the desktop patch both edit.
 *
 * THE DESKTOP IS NOT ENTIRELY OFF THAT BRANCH. Two desktop sites omit the option and so run it
 * too: the hidden rate-limit probes in `src/main/rate-limits/claude-pty.ts` and
 * `codex-pty-rate-limit-probe.ts`. Both recur -- their fetchers poll -- and both tear down through
 * `kill()`, so this hunk is live on the desktop, just never for a pane a user can see. Do not
 * restate this as "the desktop never executes that branch": that sentence stood here for two
 * revisions and is false.
 *
 * What the numbers above therefore do NOT cover: they were measured on relay-style spawn/kill
 * cycles. Whether the early placement costs the same +2 File / +1 Process across a probe's
 * lifecycle is UNMEASURED -- plausible, not established, and worth measuring before anyone quotes
 * a desktop figure. What IS settled is the claim this comment replaced: that the desktop patch made
 * every Windows user worse off ON EVERY TERMINAL. Terminals take the DLL branch, and the harness
 * that produced that claim defaulted into the branch it was not trying to measure.
 *
 * The divergence is therefore about which branch each host runs for the workload that matters, not
 * about a regression in the terminals users open. The test still pins it, because a future "sync
 * the patches" would put the early placement onto the relay's branch, where it does cost +2 File
 * and +1 Process per terminal.
 *
 * If you extend this enumeration, grep for `node-pty` rather than for a static import: those two
 * probes were missed three times because they use `await import('node-pty')`.
 *
 * THE SELF-EXIT LEAK: FIXED FOR THE DESKTOP BY #18635, STILL LIVE ON A RELAY. A terminal that exits
 * on its own is also torn down through `kill()` -- both hosts call `destroy()` on natural exit and
 * `WindowsTerminal.destroy()` is `kill()` -- but the shell is already gone by then, so the ordering
 * this asset relies on does not hold. Measured over 20 self-exit cycles on the NON-DLL branch:
 * published +3 File/+1 Process per terminal, desktop patch placement +2/+1, this tree +2/+1. This
 * asset does not close it.
 *
 * #18635 does, in `config/patches/node-pty@1.1.0.patch`: the baton outlives the shell so `PtyKill`
 * still reaches `ClosePseudoConsole`, plus an unconditional conout dispose on the DLL branch. That
 * fix does not reach a Windows relay, and no hunk in THIS file can carry it, because it is mostly
 * NATIVE (`src/win/conpty.cc`) and this asset only rewrites `lib/*.js`. Three delivery paths exist
 * and none currently covers Windows:
 *
 *   - the pnpm patch does not cross the SSH boundary -- the remote `npm install` yields upstream's
 *     unpatched node-pty;
 *   - the orcad prebuild matrix now compiles win32 slots from patched source
 *     (`config/scripts/build-orcad-prebuilds.mjs`), but only standalone orcad consumes them;
 *     nothing ships them to a Windows relay host yet;
 *   - a relay asset CAN patch native source and rebuild on the host -- that is exactly what
 *     `node-pty-1.1.0-master-cloexec-patch.cjs` does -- but it returns
 *     `skipped:unsupported-platform` for anything but linux/darwin. Extending it to win32 means
 *     requiring an MSVC toolchain on the relay host, a far heavier precondition than on Linux,
 *     where node-gyp already runs at install time.
 *
 * So a Windows SSH relay still leaks a pseudoconsole per self-exiting terminal, and closing it is a
 * DELIVERY problem, not another hunk here. Do not read #18635's flat self-exit relay numbers as
 * covering deployed relays: they were measured against a locally rebuilt binary, so they describe
 * the relay CODE PATH on a patched tree, not the tree a relay host actually installs.
 */

const EXPECTED_NODE_PTY_VERSION = '1.1.0'

const WINDOWS_TERMINAL_TEARDOWN_REPLACEMENTS = [
  [
    '        var parsedEnv = _this._parseEnv(env);\n        // If the terminal is ready\n        _this._isReady = false;\n        // Functions that need to run after `ready` event is emitted.\n        _this._deferreds = [];\n        // Create new termal.\n',
    '        var parsedEnv = _this._parseEnv(env);\n        // If the terminal is ready\n        _this._isReady = false;\n        _this._killRequested = false;\n        _this._killComplete = false;\n        _this._isPipeReady = false;\n        // Functions that need to run after `ready` event is emitted.\n        _this._deferreds = [];\n        // Create new termal.\n'
  ],
  [
    "        _this._pid = _this._agent.innerPid;\n        _this._fd = _this._agent.fd;\n        _this._pty = _this._agent.pty;\n        // The forked windows terminal is not available until `ready` event is\n        // emitted.\n        _this._socket.on('ready_datapipe', function () {\n            // Run deferreds and set ready state once the first data event is received.\n            _this._socket.once('data', function () {\n                // Wait until the first data event is fired then we can run deferreds.\n                if (!_this._isReady) {\n                    // Terminal is now ready and we can avoid having to defer method\n                    // calls.\n                    _this._isReady = true;\n",
    "        _this._pid = _this._agent.innerPid;\n        _this._fd = _this._agent.fd;\n        _this._pty = _this._agent.pty;\n        // A pre-output teardown must still publish the actual pipe close.\n        _this._socket.once('close', function () {\n            if (_this._isPipeReady) {\n                _this.emit('exit', _this._agent.exitCode);\n            }\n            _this._close();\n        });\n        // The forked windows terminal is not available until `ready` event is\n        // emitted.\n        _this._socket.on('ready_datapipe', function () {\n            _this._isPipeReady = true;\n            if (_this._killRequested) {\n                _this.kill();\n                return;\n            }\n            // Run deferreds and set ready state once the first data event is received.\n            _this._socket.once('data', function () {\n                // Wait until the first data event is fired then we can run deferreds.\n                if (!_this._isReady && !_this._killRequested) {\n                    // Terminal is now ready and we can avoid having to defer method\n                    // calls.\n                    _this._isReady = true;\n"
  ],
  [
    "                    _this._deferreds = [];\n                }\n            });\n            // Cleanup after the socket is closed.\n            _this._socket.on('close', function () {\n                _this.emit('exit', _this._agent.exitCode);\n                _this._close();\n            });\n        });\n        _this._file = file;\n        _this._name = name;\n",
    '                    _this._deferreds = [];\n                }\n            });\n        });\n        _this._file = file;\n        _this._name = name;\n'
  ],
  [
    "        });\n    };\n    WindowsTerminal.prototype.destroy = function () {\n        var _this = this;\n        this._deferNoArgs(function () {\n            _this.kill();\n        });\n    };\n    WindowsTerminal.prototype.kill = function (signal) {\n        var _this = this;\n        this._deferNoArgs(function () {\n            if (signal) {\n                throw new Error('Signals not supported on windows.');\n            }\n            _this._close();\n            _this._agent.kill();\n        });\n    };\n    WindowsTerminal.prototype._deferNoArgs = function (deferredFn) {\n        var _this = this;\n        // If the terminal is ready, execute.\n        if (this._isReady) {\n",
    "        });\n    };\n    WindowsTerminal.prototype.destroy = function () {\n        this.kill();\n    };\n    WindowsTerminal.prototype.kill = function (signal) {\n        if (signal) {\n            throw new Error('Signals not supported on windows.');\n        }\n        // Retire input now; native close requires the forwarding pipe, not first output.\n        this._killRequested = true;\n        this._deferreds = [];\n        this._close();\n        if (!this._isPipeReady || this._killComplete) {\n            return;\n        }\n        this._agent.kill();\n        this._killComplete = true;\n    };\n    WindowsTerminal.prototype._deferNoArgs = function (deferredFn) {\n        if (this._killRequested) {\n            return;\n        }\n        var _this = this;\n        // If the terminal is ready, execute.\n        if (this._isReady) {\n"
  ],
  [
    '        });\n    };\n    WindowsTerminal.prototype._defer = function (deferredFn, arg) {\n        var _this = this;\n        // If the terminal is ready, execute.\n        if (this._isReady) {\n',
    '        });\n    };\n    WindowsTerminal.prototype._defer = function (deferredFn, arg) {\n        if (this._killRequested) {\n            return;\n        }\n        var _this = this;\n        // If the terminal is ready, execute.\n        if (this._isReady) {\n'
  ]
]

const PRECONNECT_AGENT_REPLACEMENTS = [
  [
    'var utils_1 = require("./utils");',
    'var utils_1 = require("./utils");\nvar eventEmitter2_1 = require("./eventEmitter2");'
  ],
  [
    '        this._innerPid = 0;',
    '        this._innerPid = 0;\n        this._onProcessExit = new eventEmitter2_1.EventEmitter2();'
  ],
  [
    '    WindowsPtyAgent.prototype.kill = function () {',
    '    Object.defineProperty(WindowsPtyAgent.prototype, "onProcessExit", {\n        get: function () { return this._onProcessExit.event; },\n        enumerable: false,\n        configurable: true\n    });\n    Object.defineProperty(WindowsPtyAgent.prototype, "isConpty", {\n        get: function () { return this._useConpty === true; },\n        enumerable: false,\n        configurable: true\n    });\n    WindowsPtyAgent.prototype.killAfterOutputClosed = function () {\n        var _this = this;\n        return this._conoutSocketWorker.disposeImmediately().then(function () { return _this.kill(); });\n    };\n    WindowsPtyAgent.prototype.kill = function () {'
  ],
  [
    "            this._outSocket.on('data', function () { return _this._flushDataAndCleanUp(); });\n        }\n    };",
    "            this._outSocket.on('data', function () { return _this._flushDataAndCleanUp(); });\n        }\n        this._onProcessExit.fire(exitCode);\n    };"
  ]
]

const PRECONNECT_TERMINAL_REPLACEMENTS = [
  [
    '        _this._isPipeReady = false;',
    '        _this._isPipeReady = false;\n        _this._exitEmitted = false;\n        _this._preconnectCleanupRequested = false;'
  ],
  [
    "        // A pre-output teardown must still publish the actual pipe close.\n        _this._socket.once('close', function () {\n            if (_this._isPipeReady) {\n                _this.emit('exit', _this._agent.exitCode);\n            }\n            _this._close();\n        });",
    "        _this._agent.onProcessExit(function () {\n            if (_this._killRequested) _this._emitExit();\n        });\n        _this._socket.once('close', function () {\n            if (_this._isPipeReady && !_this._preconnectCleanupRequested && (!_this._killRequested || !_this._agent.isConpty || _this._agent.exitCode !== undefined)) _this._emitExit();\n            _this._close();\n            if (_this._killRequested && !_this._isPipeReady) _this._killAfterOutputClosed();\n        });"
  ],
  [
    '        if (!this._isPipeReady || this._killComplete) {\n            return;\n        }',
    '        if (this._killComplete || this._preconnectCleanup) return;\n        if (this._preconnectCleanupRequested || (!this._isPipeReady && this._socket.destroyed)) {\n            this._killAfterOutputClosed();\n            return;\n        }\n        if (!this._isPipeReady) return;'
  ],
  [
    '    WindowsTerminal.prototype._deferNoArgs =',
    "    WindowsTerminal.prototype._emitExit = function () {\n        if (this._exitEmitted) return;\n        this._exitEmitted = true;\n        this.emit('exit', this._agent.exitCode);\n    };\n    WindowsTerminal.prototype._killAfterOutputClosed = function () {\n        var _this = this;\n        if (!this._agent.isConpty || this._killComplete || this._preconnectCleanup) return;\n        this._preconnectCleanupRequested = true;\n        this._preconnectCleanup = this._agent.killAfterOutputClosed().then(function () {\n            _this._killComplete = true;\n            if (_this._agent.exitCode !== undefined) _this._emitExit();\n        }, function (error) {\n            _this._preconnectCleanup = undefined;\n            if (_this.listeners('error').length > 1) {\n                _this.emit('error', error);\n            }\n        });\n        if (this._agent.exitCode !== undefined) this._emitExit();\n    };\n    WindowsTerminal.prototype._deferNoArgs ="
  ]
]

const PRECONNECT_CONOUT_REPLACEMENTS = [
  [
    '                case 1 /* READY */:\n                    _this._onReady.fire();',
    '                case 1 /* READY */:\n                    if (_this._termination) return;\n                    _this._onReady.fire();'
  ],
  [
    '    ConoutConnection.prototype.connectSocket = function (socket) {\n        socket.connect',
    '    ConoutConnection.prototype.disposeImmediately = function () {\n        this._isDisposed = true;\n        if (this._drainTimeout) clearTimeout(this._drainTimeout);\n        return this._destroySocket();\n    };\n    ConoutConnection.prototype.connectSocket = function (socket) {\n        if (this._termination) return;\n        socket.connect'
  ],
  [
    '    ConoutConnection.prototype._destroySocket = function () {\n        return __awaiter(this, void 0, void 0, function () {\n            return __generator(this, function (_a) {\n                switch (_a.label) {\n                    case 0: return [4 /*yield*/, this._worker.terminate()];\n                    case 1:\n                        _a.sent();\n                        return [2 /*return*/];\n                }\n            });\n        });\n    };\n',
    '    ConoutConnection.prototype._destroySocket = function () {\n        if (!this._termination) {\n            this._termination = this._worker.terminate().then(function () { return undefined; });\n        }\n        return this._termination;\n    };\n'
  ]
]

/** Each entry is one published file, its patched form, and the edits between them. */
const PATCH_TARGETS = [
  {
    relativePath: ['lib', 'windowsConoutConnection.js'],
    originalSha256: '1440f70908fb1f55911ac8e936a1230f68a9c00c03096fcef6788eac6aad9d62',
    patchedSha256: '37fab0688764326444509f7ffb24369f99fda4fbe29db72dccfad52c457ba244',
    replacements: PRECONNECT_CONOUT_REPLACEMENTS
  },
  {
    relativePath: ['lib', 'windowsPtyAgent.js'],
    originalSha256: '8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a',
    patchedSha256: '3c14daf8d0ec2d1e2d66435caa5fb2b629b230e237873594e623e79e6a7d1223',
    previousPatchedSha256: '1e23ef480569e73706e3ab4f5482c7e553c76f51414ae8e7b0bdcc2fd75f7280',
    previousReplacements: PRECONNECT_AGENT_REPLACEMENTS,
    replacements: [
      [
        '                this._ptyNative.kill(this._pty, this._useConptyDll);\n                this._conoutSocketWorker.dispose();\n',
        '                this._ptyNative.kill(this._pty, this._useConptyDll);\n                this._conoutSocketWorker.dispose();\n                // Orca: released AFTER the console-list fork and the native kill, not before them.\n                // Destroying conin first aborts teardown partway -- measured on a Windows SSH relay\n                // as +2 File and +1 Process handles per terminal, against +1 File unpatched.\n                this._inSocket.destroy();\n'
      ],
      ...PRECONNECT_AGENT_REPLACEMENTS
    ]
  },
  {
    relativePath: ['lib', 'windowsTerminal.js'],
    originalSha256: 'c3a65716f53fed0135a8a633373d5f9c2ab092544d651f27ef0a67096dd3bcd9',
    patchedSha256: '5dfeb1dda46645e1d77964ad4d07072b34f0a897dfc7e785137cc39e755b4641',
    additionalPreviousVariants: [
      {
        sha256: '3060c6514a8e9e3285f91b9b549930e7d25d59d4cf7e1ed3a25b9a680dd1ded5',
        replacements: PRECONNECT_TERMINAL_REPLACEMENTS
      },
      {
        sha256: '598755ee75307d041a72cd7c7c4e12ae4a4bbf35eee19da67b42b61fdae0d4d6',
        replacements: [
          [
            "            _this._preconnectCleanup = undefined;\n            _this.emit('error', error);",
            "            _this._preconnectCleanup = undefined;\n            if (_this.listeners('error').length > 1) {\n                _this.emit('error', error);\n            }"
          ],
          [
            '            if (_this._preconnectCleanupRequested) _this._emitExit();',
            '            if (_this._killRequested) _this._emitExit();'
          ],
          [
            '            if (_this._isPipeReady && !_this._preconnectCleanupRequested) _this._emitExit();',
            '            if (_this._isPipeReady && !_this._preconnectCleanupRequested && (!_this._killRequested || !_this._agent.isConpty || _this._agent.exitCode !== undefined)) _this._emitExit();'
          ]
        ]
      }
    ],
    previousPatchedSha256: '8247ecd69be8b18257050fb026b290024612c5ffc6d492ff1d46f81e613be2cf',
    previousReplacements: [
      ...WINDOWS_TERMINAL_TEARDOWN_REPLACEMENTS,
      ...PRECONNECT_TERMINAL_REPLACEMENTS
    ],
    replacements: [
      [
        '        _this._agent = new windowsPtyAgent_1.WindowsPtyAgent(file, args, parsedEnv, cwd, _this._cols, _this._rows, false, opt.useConpty, opt.useConptyDll, opt.conptyInheritCursor);\n        _this._socket = _this._agent.outSocket;\n        // Not available until `ready` event emitted.\n        _this._pid = _this._agent.innerPid;',
        "        _this._agent = new windowsPtyAgent_1.WindowsPtyAgent(file, args, parsedEnv, cwd, _this._cols, _this._rows, false, opt.useConpty, opt.useConptyDll, opt.conptyInheritCursor);\n        _this._socket = _this._agent.outSocket;\n        // Attach before readiness so a broken ConPTY output pipe cannot be unhandled.\n        _this._socket.on('error', function (err) {\n            var code = err && err.code;\n            // PTY output can report EPIPE before `_close()` wins the race.\n            _this._close();\n            if (code === 'EPIPE' || code === 'ERR_STREAM_PUSH_AFTER_EOF' || code === 'ERR_STREAM_DESTROYED') {\n                return;\n            }\n            // EIO, happens when someone closes our child process: the only process\n            // in the terminal.\n            // node < 0.6.14: errno 5\n            // node >= 0.6.14: read EIO\n            if (typeof code === 'string') {\n                if (~code.indexOf('errno 5') || ~code.indexOf('EIO'))\n                    return;\n            }\n            // Throw anything else.\n            if (_this.listeners('error').length < 2) {\n                throw err;\n            }\n        });\n        // Not available until `ready` event emitted.\n        _this._pid = _this._agent.innerPid;"
      ],
      [
        "                }\n            });\n            // Shutdown if `error` event is emitted.\n            _this._socket.on('error', function (err) {\n                // Close terminal session.\n                _this._close();\n                // EIO, happens when someone closes our child process: the only process\n                // in the terminal.\n                // node < 0.6.14: errno 5\n                // node >= 0.6.14: read EIO\n                if (err.code) {\n                    if (~err.code.indexOf('errno 5') || ~err.code.indexOf('EIO'))\n                        return;\n                }\n                // Throw anything else.\n                if (_this.listeners('error').length < 2) {\n                    throw err;\n                }\n            });\n            // Cleanup after the socket is closed.\n            _this._socket.on('close', function () {",
        "                }\n            });\n            // Cleanup after the socket is closed.\n            _this._socket.on('close', function () {"
      ],
      [
        '        _this._readable = true;\n        _this._writable = true;\n        _this._forwardEvents();\n        return _this;',
        "        _this._readable = true;\n        _this._writable = true;\n        // A ConPTY input-pipe error must retire only this terminal. Without a listener, Node promotes\n        // errors such as write EAGAIN to uncaughtException and kills every PTY in the daemon.\n        _this._agent.inSocket.on('error', function () {\n            if (!_this._writable) {\n                return;\n            }\n            _this._close();\n            try {\n                _this._agent.kill();\n            }\n            catch (_a) {\n                // The failing pipe may have raced process exit; the terminal is already unwritable.\n            }\n        });\n        _this._forwardEvents();\n        return _this;"
      ],
      [
        'exports.WindowsTerminal = WindowsTerminal;\n//# sourceMappingURL=windowsTerminal.js.map',
        'exports.WindowsTerminal = WindowsTerminal;\n//# sourceMappingURL=windowsTerminal.js.map\n'
      ],
      ...WINDOWS_TERMINAL_TEARDOWN_REPLACEMENTS,
      ...PRECONNECT_TERMINAL_REPLACEMENTS
    ]
  }
]

function inspectTarget(relayDir, target) {
  const nodePtyDir = resolve(relayDir, 'node_modules', 'node-pty')
  const packageJson = JSON.parse(readFileSync(join(nodePtyDir, 'package.json'), 'utf8'))
  if (packageJson.version !== EXPECTED_NODE_PTY_VERSION) {
    throw new Error(
      `Refusing to patch node-pty ${packageJson.version}; expected ${EXPECTED_NODE_PTY_VERSION}`
    )
  }
  const filePath = join(nodePtyDir, ...target.relativePath)
  return { filePath, source: readFileSync(filePath, 'utf8') }
}

function assertPatchedNodePtyWindowsTeardown(relayDir = process.cwd()) {
  for (const target of PATCH_TARGETS) {
    const inspected = inspectTarget(relayDir, target)
    if (sourceSha256(inspected.source) !== target.patchedSha256) {
      throw new Error(
        `node-pty ConPTY teardown release is not installed in ${target.relativePath.join('/')}`
      )
    }
  }
}

function patchNodePtyWindowsTeardown(relayDir = process.cwd()) {
  const pending = []
  for (const target of PATCH_TARGETS) {
    const inspected = inspectTarget(relayDir, target)
    const sourceHash = sourceSha256(inspected.source)
    if (sourceHash === target.patchedSha256) {
      continue
    }
    const replacements =
      sourceHash === target.originalSha256
        ? target.replacements
        : sourceHash === target.previousPatchedSha256
          ? target.previousReplacements
          : target.additionalPreviousVariants?.find((entry) => entry.sha256 === sourceHash)
              ?.replacements
    if (!replacements) {
      throw new Error(
        `Refusing to patch unexpected node-pty source in ${target.relativePath.join('/')}`
      )
    }
    let patchedSource = inspected.source
    for (const [from, to] of replacements) {
      // Why the count check: an anchor that matched twice would patch the wrong site silently, and
      // the hash below would then reject a tree this script had already rewritten.
      if (patchedSource.split(from).length - 1 !== 1) {
        throw new Error(`Refusing to patch ${target.relativePath.join('/')}; anchor is not unique`)
      }
      patchedSource = patchedSource.replace(from, to)
    }
    if (sourceSha256(patchedSource) !== target.patchedSha256) {
      throw new Error(
        `Refusing to install unexpected patched node-pty source in ${target.relativePath.join('/')}`
      )
    }
    pending.push({ filePath: inspected.filePath, patchedSource })
  }
  for (const { filePath, patchedSource } of pending) {
    const temporaryPath = `${filePath}.orca-patch-${process.pid}`
    // Why: a terminated remote install must leave either known source version recoverable on reconnect.
    try {
      writeFileSync(temporaryPath, patchedSource)
      renameSync(temporaryPath, filePath)
    } finally {
      rmSync(temporaryPath, { force: true })
    }
  }
  assertPatchedNodePtyWindowsTeardown(relayDir)
}

function sourceSha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

if (require.main === module) {
  patchNodePtyWindowsTeardown()
}

module.exports = {
  assertPatchedNodePtyWindowsTeardown,
  patchNodePtyWindowsTeardown
}
