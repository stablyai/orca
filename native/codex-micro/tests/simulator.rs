use codex_micro::sidecar_protocol::write_frame;
use serde_json::Value;
use std::io::{Read, Write};
use std::process::{Command, Stdio};

fn read_frames(bytes: &[u8]) -> Vec<Value> {
    let mut frames = Vec::new();
    let mut offset = 0;
    while offset + 4 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        assert!(
            offset + len <= bytes.len(),
            "declared frame length runs past captured stdout"
        );
        let frame: Value =
            serde_json::from_slice(&bytes[offset..offset + len]).expect("frame body is valid JSON");
        frames.push(frame);
        offset += len;
    }
    frames
}

#[test]
fn simulator_replays_ag_act_encoder_and_radar_events_through_framed_stdout() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_codex-micro"))
        .args(["--simulate", "fixtures"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn simulator");

    let light = serde_json::json!({"e": 1, "b": 0.5, "s": 0, "m": 0, "c": "0xffffff"});
    let slots: Vec<Value> = (0..6)
        .map(|id| serde_json::json!({"id": id, "c": "0xffffff", "b": 0.5, "e": 1, "s": 0, "sk": 0, "sa": 0}))
        .collect();
    let snapshot = serde_json::json!({
        "version": 1,
        "type": "output_snapshot",
        "rgbcfg": {"ambient": light, "keys": light},
        "thstatus": slots,
    });
    let release = serde_json::json!({"version": 1, "type": "release"});
    {
        let mut stdin = child.stdin.take().expect("simulator stdin");
        write_frame(&mut stdin, &snapshot).unwrap();
        write_frame(&mut stdin, &snapshot).unwrap();
        write_frame(&mut stdin, &release).unwrap();
        stdin.flush().unwrap();
    }

    let mut stdout_bytes = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout_bytes)
        .expect("read simulator stdout");
    let status = child.wait().expect("wait for simulator");
    assert!(status.success());

    let frames = read_frames(&stdout_bytes);
    assert!(!frames.is_empty());

    assert_eq!(frames[0]["type"], "handshake");
    assert_eq!(frames[1]["type"], "connection_state");

    let events: Vec<&Value> = frames
        .iter()
        .filter(|frame| frame["type"] == "input_event")
        .map(|frame| &frame["event"])
        .collect();

    let has_control = |control: &str| {
        events
            .iter()
            .any(|event| event["kind"] == "control" && event["control"] == control)
    };
    assert!(has_control("AG00"), "AG event must be replayed");
    assert!(has_control("ACT06"), "ACT event must be replayed");
    assert!(has_control("ENC_CC"), "encoder event must be replayed");

    let has_radar = events.iter().any(|event| event["kind"] == "radar");
    assert!(has_radar, "radar event must be replayed");

    let outcomes: Vec<&str> = frames
        .iter()
        .filter(|frame| frame["type"] == "snapshot_result")
        .map(|frame| frame["outcome"].as_str().unwrap())
        .collect();
    assert_eq!(
        outcomes,
        vec!["matched", "matched", "duplicate", "duplicate"]
    );
}
