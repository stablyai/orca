"""Build an offscreen WKWebView app and run it in a disposable, headless simulator."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time

from cleanup import cleanup
from observations import validate

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parent
ENV = {**os.environ, "ORCA_BACKGROUND_LAUNCH": "1", "SIMCTL_CHILD_ORCA_BACKGROUND_LAUNCH": "1"}


def command(*args, **kwargs):
    return subprocess.run(args, env=ENV, check=True, text=True, **kwargs)


def main():
    if sys.platform != "darwin":
        raise SystemExit("Requires macOS, Xcode, and an installed iOS simulator runtime")
    artifacts = Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="orca-ios-proxy-")).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    if (artifacts / "ports.json").exists() or (artifacts / "results.json").exists():
        raise SystemExit("Use a fresh artifact directory; existing run evidence must not be overwritten")
    print(f"Artifacts: {artifacts}", flush=True)
    runtimes = json.loads(command("xcrun", "simctl", "list", "runtimes", "--json", capture_output=True).stdout)
    available = [r for r in runtimes["runtimes"] if r["isAvailable"] and r["name"].startswith("iOS ")]
    if not available:
        raise SystemExit("No usable iOS simulator runtime installed")
    runtime = available[-1]
    types = json.loads(command("xcrun", "simctl", "list", "devicetypes", "--json", capture_output=True).stdout)
    device_type = next(t["identifier"] for t in types["devicetypes"] if t["name"] == "iPhone 17 Pro")
    app = artifacts / "ProxyProbe.app"
    app.mkdir(exist_ok=True)
    metadata = {"CFBundleIdentifier": "dev.orca.proxy-proof", "CFBundleExecutable": "ProxyProbe",
                "CFBundleName": "ProxyProbe", "CFBundlePackageType": "APPL", "CFBundleVersion": "1",
                "CFBundleShortVersionString": "1.0", "MinimumOSVersion": "17.0",
                "UIDeviceFamily": [1, 2], "LSRequiresIPhoneOS": True,
                "NSAppTransportSecurity": {"NSAllowsArbitraryLoads": True}}
    with (app / "Info.plist").open("wb") as file:
        plistlib.dump(metadata, file)
    sdk = command("xcrun", "--sdk", "iphonesimulator", "--show-sdk-path", capture_output=True).stdout.strip()
    arch = os.uname().machine
    command("xcrun", "--sdk", "iphonesimulator", "swiftc", "-parse-as-library", "-sdk", sdk, "-target", f"{arch}-apple-ios17.0-simulator",
            str(SOURCE / "ProxyProbe.swift"), str(SOURCE / "LoopbackRelay.swift"),
            str(SOURCE / "PolicyProbe.swift"), "-o", str(app / "ProxyProbe"))
    command("codesign", "--force", "--sign", "-", str(app))
    fixture_script = artifacts / "fixture.cjs"
    command(str(ROOT / "node_modules/.bin/esbuild"), str(SOURCE / "fixture.ts"),
            "--bundle", "--platform=node", "--format=cjs", "--outfile=" + str(fixture_script))
    device = None
    fixture = None
    try:
        with (artifacts / "fixture.log").open("w") as log:
            fixture = subprocess.Popen(["node", str(fixture_script), str(artifacts)],
                                       cwd=ROOT, env=ENV, stdout=log, stderr=log, start_new_session=True)
        for _ in range(120):
            if (artifacts / "ports.json").exists():
                break
            if fixture.poll() is not None:
                raise RuntimeError("Fixture failed; see fixture.log")
            time.sleep(1)
        ports = json.loads((artifacts / "ports.json").read_text())
        device = command("xcrun", "simctl", "create", "Orca isolated proxy proof", device_type,
                         runtime["identifier"], capture_output=True).stdout.strip()
        (artifacts / "environment.json").write_text(json.dumps({"runtime": runtime, "device": device,
            "xcode": command("xcodebuild", "-version", capture_output=True).stdout}, indent=2))
        command("xcrun", "simctl", "boot", device)
        command("xcrun", "simctl", "bootstatus", device, "-b")
        command("xcrun", "simctl", "install", device, str(app))
        command("xcrun", "simctl", "launch", "--stdout=" + str(artifacts / "stdout.log"),
                "--stderr=" + str(artifacts / "stderr.log"), device, metadata["CFBundleIdentifier"],
                *(str(ports[key]) for key in ["a", "b", "origin", "control"]))
        container = Path(command("xcrun", "simctl", "get_app_container", device,
                                 metadata["CFBundleIdentifier"], "data", capture_output=True).stdout.strip())
        result_file = container / "Documents/results.json"
        lifecycle_tested = False
        for _ in range(150):
            if result_file.exists():
                shutil.copyfile(result_file, artifacts / "results.json")
                results = json.loads(result_file.read_text())
                if not lifecycle_tested and any(row["case"] == "lifecycle-ready" for row in results):
                    command("xcrun", "simctl", "launch", device, "com.apple.Preferences")
                    time.sleep(5)
                    command("xcrun", "simctl", "launch", device, metadata["CFBundleIdentifier"])
                    lifecycle_tested = True
                if results[-1]["case"] == "complete":
                    validate(results, [json.loads(line) for line in (artifacts / "network.jsonl").read_text().splitlines()])
                    print(json.dumps(results, indent=2))
                    return
            time.sleep(1)
        raise RuntimeError("Native probe did not complete within 150 seconds; see artifacts")
    finally:
        cleanup(artifacts, device, fixture, command, sys.exc_info()[1])


if __name__ == "__main__":
    main()
