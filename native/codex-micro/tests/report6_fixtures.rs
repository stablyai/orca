use codex_micro::events::{ControlId, DeviceEvent};
use codex_micro::report6::Report6Parser;
use serde_json::Value;
use std::fs;

const REPORT_ID: u8 = 6;
const FRAME_MARKER: u8 = 2;
const REPORT_SIZE: usize = 64;

fn pack_report(payload: &[u8]) -> Vec<u8> {
    assert!(
        payload.len() <= 61,
        "payload exceeds 61-byte JSON chunk capacity"
    );
    let mut report = Vec::with_capacity(REPORT_SIZE);
    report.push(REPORT_ID);
    report.push(FRAME_MARKER);
    report.push(payload.len() as u8);
    report.extend_from_slice(payload);
    report.resize(REPORT_SIZE, 0);
    report
}

fn control_id_from_wire(name: &str) -> ControlId {
    ControlId::from_wire(name).unwrap_or_else(|| panic!("unknown control id in fixture: {name}"))
}

fn wire_bytes_for_input_event(event: &Value) -> Vec<u8> {
    let control = event["control"].as_str().expect("control field");
    let action = event["action"].as_u64().expect("action field");
    format!("{{\"m\":\"v.oai.hid\",\"p\":{{\"k\":\"{control}\",\"act\":{action}}}}}").into_bytes()
}

fn wire_bytes_for_radar_event(event: &Value) -> Vec<u8> {
    let angle = event["angle"].as_f64().expect("angle field");
    let distance = event["distance"].as_f64().expect("distance field");
    format!("{{\"m\":\"v.oai.rad\",\"p\":{{\"a\":{angle},\"d\":{distance}}}}}").into_bytes()
}

#[test]
fn decodes_every_captured_control_event_from_a_single_report() {
    let fixture: Value = serde_json::from_str(
        &fs::read_to_string("fixtures/input-events.json").expect("read input-events.json"),
    )
    .expect("parse input-events.json");

    for event in fixture["events"].as_array().expect("events array") {
        let payload = wire_bytes_for_input_event(event);
        let mut parser = Report6Parser::new();
        let result = parser.push_report(&pack_report(&payload));

        let expected_control = control_id_from_wire(event["control"].as_str().unwrap());
        let expected_action = event["action"].as_u64().unwrap() as u8;

        assert_eq!(result.events.len(), 1, "event: {event}");
        assert_eq!(
            result.events[0],
            DeviceEvent::Control {
                control: expected_control,
                action: expected_action
            },
            "event: {event}"
        );
        assert!(result.response_chunks.is_empty(), "event: {event}");
    }
}

#[test]
fn decodes_every_captured_radar_event_from_a_single_report() {
    let fixture: Value = serde_json::from_str(
        &fs::read_to_string("fixtures/radar-events.json").expect("read radar-events.json"),
    )
    .expect("parse radar-events.json");

    for event in fixture["events"].as_array().expect("events array") {
        let payload = wire_bytes_for_radar_event(event);
        let mut parser = Report6Parser::new();
        let result = parser.push_report(&pack_report(&payload));

        let expected_angle = event["angle"].as_f64().unwrap();
        let expected_distance = event["distance"].as_f64().unwrap();

        assert_eq!(result.events.len(), 1, "event: {event}");
        match &result.events[0] {
            DeviceEvent::Radar { angle, distance } => {
                assert_eq!(*angle, expected_angle, "event: {event}");
                assert_eq!(*distance, expected_distance, "event: {event}");
            }
            other => panic!("expected radar event, got {other:?}"),
        }
    }
}

#[test]
fn rejects_a_report_claiming_a_chunk_length_over_61_bytes() {
    let mut report = vec![REPORT_ID, FRAME_MARKER, 62];
    report.extend(std::iter::repeat(b'x').take(62));
    report.resize(REPORT_SIZE, 0);

    let mut parser = Report6Parser::new();
    let result = parser.push_report(&report);

    assert!(result.events.is_empty());
    assert!(result.response_chunks.is_empty());
}

#[test]
fn ignores_a_report_with_the_wrong_frame_marker() {
    let payload = b"{\"m\":\"v.oai.hid\",\"p\":{\"k\":\"AG00\",\"act\":1}}";
    let mut report = vec![REPORT_ID, 0x99, payload.len() as u8];
    report.extend_from_slice(payload);
    report.resize(REPORT_SIZE, 0);

    let mut parser = Report6Parser::new();
    let result = parser.push_report(&report);

    assert!(result.events.is_empty());
    assert!(result.response_chunks.is_empty());
}

#[test]
fn bounds_an_endless_incomplete_json_prefix() {
    let mut parser = Report6Parser::new();
    assert!(parser
        .push_report(&pack_report(b"{\"x\":\""))
        .response_chunks
        .is_empty());

    let continuation = [b'a'; 61];
    let mut flushed = false;
    for _ in 0..80 {
        flushed |= !parser
            .push_report(&pack_report(&continuation))
            .response_chunks
            .is_empty();
    }

    assert!(
        flushed,
        "an incomplete device message must not grow memory without bound"
    );
}

#[test]
fn assembles_a_complete_non_interleaved_response_across_two_reports() {
    let ack = b"{\"result\":{\"ok\":1},\"id\":42,\"method\":\"v.oai.rgbcfg\"}";
    let (first, second) = ack.split_at(30);

    let mut parser = Report6Parser::new();
    let r1 = parser.push_report(&pack_report(first));
    assert!(r1.events.is_empty());
    assert!(
        r1.response_chunks.is_empty(),
        "incomplete ack must not flush early"
    );

    let r2 = parser.push_report(&pack_report(second));
    assert!(r2.events.is_empty());
    assert_eq!(r2.response_chunks.len(), 1);
    assert_eq!(r2.response_chunks[0], ack);
}

#[test]
fn extracts_the_ag00_event_and_leaves_the_split_response_indeterminate() {
    let fixture: Value = serde_json::from_str(
        &fs::read_to_string("fixtures/interleaved-report6.json")
            .expect("read interleaved-report6.json"),
    )
    .expect("parse interleaved-report6.json");

    let reports = fixture["reports"].as_array().expect("reports array");
    let expected_events = fixture["expectedEvents"]
        .as_array()
        .expect("expectedEvents array");
    assert_eq!(expected_events.len(), 1);
    let expected_control = control_id_from_wire(expected_events[0]["control"].as_str().unwrap());
    let expected_action = expected_events[0]["action"].as_u64().unwrap() as u8;

    let mut parser = Report6Parser::new();
    let mut all_events = Vec::new();
    let mut all_response_chunks: Vec<Vec<u8>> = Vec::new();

    for report in reports {
        let bytes: Vec<u8> = report
            .as_array()
            .expect("report byte array")
            .iter()
            .map(|b| b.as_u64().expect("byte value") as u8)
            .collect();
        let result = parser.push_report(&bytes);
        all_events.extend(result.events);
        all_response_chunks.extend(result.response_chunks);
    }

    assert_eq!(
        all_events,
        vec![DeviceEvent::Control {
            control: expected_control,
            action: expected_action
        }],
        "the complete AG00 event must never be sacrificed for the interleaved ack"
    );

    assert!(
        !fixture["expectedResponseComplete"].as_bool().unwrap(),
        "fixture must describe an indeterminate response"
    );
    assert!(
        all_response_chunks.len() >= 2,
        "the interleaved ack must never be silently merged back into one chunk"
    );
    for chunk in &all_response_chunks {
        assert!(
            serde_json::from_slice::<Value>(chunk).is_err(),
            "no individual fragment may parse as a complete response on its own"
        );
    }
}
